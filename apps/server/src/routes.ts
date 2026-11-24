import { toolMeta } from "@munshi/mcp-common";
import { desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ActionError } from "./agent/executor.js";
import type { Db } from "./db/index.js";
import { schema } from "./db/index.js";
import { PolicyRule } from "./guard/policy.js";
import { normalizeAddress } from "./guard/provenance.js";
import type { Services } from "./services.js";
import { USER_ID } from "./scan.js";
import { listNudges } from "./nudges.js";
import { TELEGRAM_SETUP } from "./telegram/channel.js";

const json = (s: string | null) => {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
};

type ActionRow = typeof schema.actions.$inferSelect;

export function serializeAction(a: ActionRow) {
  const g = json(a.guardJson) ?? {};
  const meta = toolMeta(a.tool);
  const undoable = a.status === "held" || (["executed", "verified", "verification_failed"].includes(a.status) && Boolean(meta?.undoTool));
  return {
    id: a.id, runId: a.runId, obligationId: a.obligationId, tool: a.tool, tier: a.riskTier,
    args: json(a.argsJson), tainted: a.tainted, decision: a.decision, reason: a.decisionReason, rule: g.rule ?? null,
    status: a.status, preview: g.preview ?? null, warnings: (g.warnings ?? []) as string[],
    taint: ((g.taint ?? []) as { arg: string; value: string; trusted: boolean; allowlisted: boolean; explanation: string; origins?: { kind: string; emailId: string | null; sender: string | null; subject: string | null; hidden: boolean }[] }[]),
    holdUntil: a.holdUntil, result: json(a.resultJson), verify: json(a.verifyJson), createdAt: a.createdAt,
    canUndo: undoable,
    undoHint: a.status === "held" ? "Cancel send" : undoable ? "Undo" : a.tool === "send_email" && a.status !== "undone" ? "Already sent; can't be undone" : null,
  };
}

export function registerAgentRoutes(app: FastifyInstance, db: Db, services: Services | undefined) {
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ActionError) return reply.code(err.status).send({ error: err.message });
    if (err instanceof z.ZodError) return reply.code(400).send({ error: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    // Anything else: always a clean JSON body for the UI ({error}), full detail in the server log, process stays up.
    const status = (err as { statusCode?: number }).statusCode;
    const message = err instanceof Error ? err.message : String(err);
    if (status && status >= 400 && status < 500) return reply.code(status).send({ error: message });
    app.log.error({ err }, "request failed");
    console.error(`[request error] ${err instanceof Error ? (err.stack ?? message) : message}`);
    return reply.code(500).send({ error: `Internal error: ${message}` });
  });

  // ---- runs ----
  app.post("/api/runs", async (req, reply) => {
    if (!services?.runtime) return reply.code(503).send({ error: `Agent not available: ${services?.agentError ?? "LLM not configured"}` });
    const { goal } = z.object({ goal: z.string().trim().min(3).max(1000) }).parse(req.body);
    return { runId: services.runtime.start(goal) };
  });

  app.get("/api/runs", async () => ({
    runs: db.select({ id: schema.agentRuns.id, goal: schema.agentRuns.goal, status: schema.agentRuns.status, startedAt: schema.agentRuns.startedAt, finishedAt: schema.agentRuns.finishedAt })
      .from(schema.agentRuns).orderBy(desc(schema.agentRuns.startedAt)).limit(30).all(),
  }));

  app.get("/api/runs/:id", async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const run = db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, id)).get();
    if (!run) return reply.code(404).send({ error: "Run not found" });
    const actions = db.select().from(schema.actions).where(eq(schema.actions.runId, id)).orderBy(schema.actions.createdAt).all();
    return {
      run: { id: run.id, goal: run.goal, status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt },
      trace: json(run.traceJson) ?? [],
      actions: actions.map(serializeAction),
    };
  });

  // ---- actions: approvals, activity, undo ----
  app.get("/api/actions", async (req) => {
    const { status } = z.object({ status: z.string().optional() }).parse(req.query);
    const rows = db.select().from(schema.actions).orderBy(desc(schema.actions.createdAt)).limit(200).all();
    return { actions: rows.filter((r) => !status || r.status === status).map(serializeAction) };
  });

  const exec = () => {
    if (!services) throw new ActionError("Services unavailable", 503);
    return services.executor;
  };
  app.post("/api/actions/:id/approve", async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { acknowledgeTaint } = z.object({ acknowledgeTaint: z.boolean().optional() }).parse(req.body ?? {});
    return { action: serializeAction(await exec().approve(id, { acknowledgeTaint, channel: "web" })) };
  });
  app.post("/api/actions/:id/reject", async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    return { action: serializeAction(exec().reject(id)) };
  });
  app.post("/api/actions/:id/undo", async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    return { action: serializeAction(await exec().undo(id)) };
  });

  // ---- channels + nudges ----
  app.get("/api/telegram", async () =>
    services?.telegram
      ? services.telegram.status()
      : { configured: false, linked: false, polling: false, bot: null, lastError: null, setup: TELEGRAM_SETUP },
  );
  app.get("/api/nudges", async () => ({ nudges: listNudges(db) }));

  /**
   * Security view: every blocked or tainted action with the exact rule that fired and the email that introduced the value,
   * plus every email where hidden content / injection phrasing / rejected extractor output was detected.
   */
  app.get("/api/security", async () => {
    const rows = db.select().from(schema.actions).orderBy(desc(schema.actions.createdAt)).limit(500).all();
    const actions = rows.filter((a) => a.decision === "block" || a.tainted).map((a) => {
      const s = serializeAction(a);
      const sources = new Map<string, { emailId: string | null; sender: string | null; subject: string | null; hidden: boolean; value: string }>();
      for (const t of s.taint) for (const o of t.origins ?? []) sources.set(`${o.emailId}|${t.value}`, { emailId: o.emailId, sender: o.sender, subject: o.subject, hidden: o.hidden, value: t.value });
      return { ...s, sources: [...sources.values()] };
    });
    const emails = db.select().from(schema.emails).all().flatMap((e) => {
      const f = json(e.securityFlagsJson);
      if (!f || !(f.hiddenContent?.some((h: { suspicious?: boolean }) => h.suspicious !== false) || f.injectionSuspected?.length || f.rejectedObligations?.length)) return [];
      return [{ id: e.id, from: e.fromAddr, subject: e.subject, source: e.source, flags: f }];
    });
    return { actions, emails };
  });

  app.get("/api/audit", async (req) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    return {
      entries: db.select().from(schema.auditLog).orderBy(desc(schema.auditLog.id)).limit(limit).all()
        .map((e) => ({ ...e, detail: json(e.detail) })),
    };
  });

  // ---- policies ----
  const serializePolicy = (p: typeof schema.policies.$inferSelect) => ({
    id: p.id, enabled: p.enabled, seed: p.id.startsWith("seed-"), rule: json(p.ruleJson),
    valid: PolicyRule.safeParse(json(p.ruleJson)).success,
  });
  app.get("/api/policies", async () => ({ policies: db.select().from(schema.policies).where(eq(schema.policies.userId, USER_ID)).all().map(serializePolicy) }));
  app.post("/api/policies", async (req, reply) => {
    const rule = PolicyRule.parse((req.body as { rule?: unknown })?.rule);
    if (db.select().from(schema.policies).where(eq(schema.policies.id, rule.id)).get()) return reply.code(409).send({ error: `A policy with id “${rule.id}” already exists` });
    db.insert(schema.policies).values({ id: rule.id, userId: USER_ID, ruleJson: JSON.stringify(rule) }).run();
    return { policy: serializePolicy(db.select().from(schema.policies).where(eq(schema.policies.id, rule.id)).get()!) };
  });
  app.patch("/api/policies/:id", async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    const r = db.update(schema.policies).set({ enabled }).where(eq(schema.policies.id, id)).run();
    return r.changes ? { ok: true } : reply.code(404).send({ error: "Policy not found" });
  });
  app.delete("/api/policies/:id", async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const r = db.delete(schema.policies).where(eq(schema.policies.id, id)).run();
    return r.changes ? { ok: true } : reply.code(404).send({ error: "Policy not found" });
  });

  // ---- contacts allowlist ----
  app.get("/api/contacts", async () => ({ contacts: db.select().from(schema.contacts).where(eq(schema.contacts.userId, USER_ID)).all() }));
  app.post("/api/contacts", async (req, reply) => {
    const b = z.object({ name: z.string().trim().min(1).max(80), email: z.string().email() }).parse(req.body);
    const email = normalizeAddress(b.email);
    if (db.select().from(schema.contacts).where(eq(schema.contacts.email, email)).get()) return reply.code(409).send({ error: "Contact already exists" });
    const row = { id: `c-${randomUUID().slice(0, 8)}`, userId: USER_ID, name: b.name, email };
    db.insert(schema.contacts).values(row).run();
    return { contact: row };
  });
  app.delete("/api/contacts/:id", async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const r = db.delete(schema.contacts).where(eq(schema.contacts.id, id)).run();
    return r.changes ? { ok: true } : reply.code(404).send({ error: "Contact not found" });
  });
}
