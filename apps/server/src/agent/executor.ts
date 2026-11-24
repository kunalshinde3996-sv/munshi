import { toolMeta } from "@munshi/mcp-common";
import { and, eq, lte } from "drizzle-orm";
import { audit } from "../audit.js";
import type { Db } from "../db/index.js";
import { schema } from "../db/index.js";
import type { Guard } from "../guard/guard.js";
import type { McpHub } from "../mcp/hub.js";
import { verifyAction, verifyUndo } from "./verify.js";

type ActionRow = typeof schema.actions.$inferSelect;
export class ActionError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const parse = (s: string | null) => (s ? JSON.parse(s) : null);

export interface ExecutorOptions {
  holdSeconds: number;
  clock?: () => number;
  /** Called when an action leaves pending_approval or a hold finishes (the agent runtime resumes from here). */
  onSettled?: (action: ActionRow) => void;
}

/**
 * Carries out Guard-approved actions: execute → verify → (undo). All state lives in the actions ledger,
 * so held sends and pending approvals survive a server restart.
 */
export class ActionExecutor {
  private timer: NodeJS.Timeout | null = null;
  private readonly clock: () => number;

  constructor(private readonly db: Db, private readonly mcp: McpHub, private readonly guard: Guard, private readonly opts: ExecutorOptions) {
    this.clock = opts.clock ?? Date.now;
  }

  get(id: string): ActionRow {
    const row = this.db.select().from(schema.actions).where(eq(schema.actions.id, id)).get();
    if (!row) throw new ActionError("Action not found", 404);
    return row;
  }

  private set(id: string, patch: Partial<ActionRow>) {
    this.db.update(schema.actions).set(patch).where(eq(schema.actions.id, id)).run();
  }

  // ---- approvals ----

  async approve(id: string, opts: { acknowledgeTaint?: boolean; channel?: "web" | "telegram" } = {}): Promise<ActionRow> {
    const a = this.get(id);
    if (a.status !== "pending_approval") throw new ActionError(`Action is ${a.status}, not pending approval`, 409);
    if (a.tainted && !opts.acknowledgeTaint)
      throw new ActionError("This action involves a value that came from email content, not from you. Acknowledge the warning to approve.", 400);
    this.set(id, { status: "approved" });
    audit(this.db, { event: "approved", actor: "user", runId: a.runId, actionId: id, detail: { approvedBy: "user", channel: opts.channel ?? "web", acknowledgedTaint: Boolean(opts.acknowledgeTaint) } });
    await this.executeApproved(id);
    return this.get(id);
  }

  reject(id: string, opts: { channel?: "web" | "telegram" } = {}): ActionRow {
    const a = this.get(id);
    if (a.status !== "pending_approval") throw new ActionError(`Action is ${a.status}, not pending approval`, 409);
    this.set(id, { status: "rejected" });
    audit(this.db, { event: "rejected", actor: "user", runId: a.runId, actionId: id, detail: { rejectedBy: "user", channel: opts.channel ?? "web" } });
    this.opts.onSettled?.(this.get(id));
    return this.get(id);
  }

  // ---- execution ----

  /** Entry point for any action whose status is "approved" (by policy or by the user). */
  async executeApproved(id: string): Promise<void> {
    const a = this.get(id);
    if (a.status !== "approved") throw new ActionError(`Action is ${a.status}, not approved`, 409);
    const meta = toolMeta(a.tool);
    if (meta?.riskTier === "R2") {
      // Hold window: the real send happens only after it elapses, and can be cancelled until then.
      const holdUntil = this.clock() + this.opts.holdSeconds * 1000;
      this.set(id, { status: "held", holdUntil });
      audit(this.db, { event: "held", actor: "system", runId: a.runId, actionId: id, detail: { holdSeconds: this.opts.holdSeconds, holdUntil } });
      if (this.opts.holdSeconds <= 0) await this.releaseDueHolds();
      else this.opts.onSettled?.(this.get(id));
      return;
    }
    await this.run(id);
  }

  private async run(id: string): Promise<void> {
    const a = this.get(id);
    const args = parse(a.argsJson);
    let result: any;
    try {
      result = await this.mcp.callTool(a.tool, args);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.set(id, { status: "failed", resultJson: JSON.stringify({ error }) });
      audit(this.db, { event: "failed", actor: "system", runId: a.runId, actionId: id, detail: { tool: a.tool, error } });
      this.opts.onSettled?.(this.get(id));
      return;
    }
    this.set(id, { status: "executed", resultJson: JSON.stringify(result), holdUntil: null });
    audit(this.db, { event: "executed", actor: "system", runId: a.runId, actionId: id, detail: { tool: a.tool, args } });

    const v = await verifyAction(this.mcp, a.tool, args, result);
    this.set(id, { status: v.ok ? "verified" : "verification_failed", verifyJson: JSON.stringify(v) });
    audit(this.db, { event: v.ok ? "verified" : "verification_failed", actor: "system", runId: a.runId, actionId: id, detail: v });
    this.opts.onSettled?.(this.get(id));
  }

  /** Send every held action whose window has elapsed. Safe to call repeatedly and after a restart. */
  async releaseDueHolds(): Promise<number> {
    const due = this.db.select().from(schema.actions)
      .where(and(eq(schema.actions.status, "held"), lte(schema.actions.holdUntil, this.clock()))).all();
    let released = 0;
    for (const a of due) {
      // claim: only one releaser wins
      const claim = this.db.update(schema.actions).set({ status: "approved" })
        .where(and(eq(schema.actions.id, a.id), eq(schema.actions.status, "held"))).run();
      if (claim.changes !== 1) continue;
      const late = this.clock() - (a.holdUntil ?? 0);
      audit(this.db, { event: "approved", actor: "system", runId: a.runId, actionId: a.id, detail: { releasedAfterHold: true, lateByMs: late } });
      await this.run(a.id);
      released++;
    }
    return released;
  }

  startScheduler(intervalMs = 1000) {
    if (this.timer) return;
    this.timer = setInterval(() => void this.releaseDueHolds().catch(() => undefined), intervalMs);
    this.timer.unref();
    void this.releaseDueHolds().catch(() => undefined); // pick up holds that matured while the server was down
  }

  stopScheduler() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ---- undo ----

  async undo(id: string): Promise<ActionRow> {
    const a = this.get(id);
    if (a.status === "held") {
      this.set(id, { status: "undone", holdUntil: null });
      audit(this.db, { event: "undone", actor: "user", runId: a.runId, actionId: id, detail: { how: "cancelled during hold window; nothing was sent" } });
      this.opts.onSettled?.(this.get(id));
      return this.get(id);
    }
    if (!["executed", "verified", "verification_failed"].includes(a.status)) throw new ActionError(`Action is ${a.status}; nothing to undo`, 409);
    const meta = toolMeta(a.tool);
    if (!meta?.undoTool) throw new ActionError(meta?.riskTier === "R2" ? "Already sent; email can only be cancelled during the hold window." : "This action cannot be undone.", 409);

    const args = parse(a.argsJson);
    const result = parse(a.resultJson);
    const undoArgs: Record<string, string> =
      a.tool === "create_event" ? { id: result.event.id }
      : a.tool === "create_draft" ? { id: result.draft.id }
      : { id: args.id, label: args.label };

    const auth = this.guard.authorizeUndo(meta.undoTool, undoArgs);
    if (!auth.ok) {
      audit(this.db, { event: "failed", actor: "guard", runId: a.runId, actionId: id, detail: { undo: "refused", reason: auth.reason } });
      throw new ActionError(auth.reason, 403);
    }
    await this.mcp.callTool(meta.undoTool, undoArgs);
    const v = await verifyUndo(this.mcp, meta.undoTool, undoArgs);
    this.set(id, { status: "undone", verifyJson: JSON.stringify({ ...parse(a.verifyJson), undo: v }) });
    audit(this.db, { event: "undone", actor: "user", runId: a.runId, actionId: id, detail: { undoTool: meta.undoTool, undoArgs, verified: v } });
    this.opts.onSettled?.(this.get(id));
    return this.get(id);
  }
}
