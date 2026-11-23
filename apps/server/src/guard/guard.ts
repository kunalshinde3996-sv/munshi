import { strictArgSchema, toolMeta, TOOL_META, type RiskTier, type ToolMeta, type ToolName } from "@munshi/mcp-common";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { audit } from "../audit.js";
import type { Db } from "../db/index.js";
import { schema } from "../db/index.js";
import { buildPreview } from "./preview.js";
import { evaluatePolicies, PolicyRule, SEED_POLICIES, type PolicyDecision } from "./policy.js";
import { normalizeAddress, ProvenanceStore, type ValueTrace } from "./provenance.js";

export type GuardDecision = PolicyDecision | "skip";

export interface ProposedCall {
  runId: string;
  tool: string;
  args: unknown;
  /** The obligation this call is for (drives idempotency and confidence-based policy). */
  obligationId?: string;
}

export interface TaintFinding {
  arg: string;
  value: string;
  trusted: boolean;
  allowlisted: boolean;
  explanation: string;
  trace: ValueTrace;
}

export interface GuardCheck {
  step: "tool" | "schema" | "tier" | "obligation" | "provenance" | "idempotency" | "policy" | "invariants";
  outcome: "pass" | "fail" | "info";
  detail: string;
}

export interface GuardResult {
  tool: string;
  args: Record<string, unknown>;
  tier: RiskTier | null;
  decision: GuardDecision;
  /** Human-readable reason shown to the user. */
  reason: string;
  /** Which rule determined the decision: a policy id, or "guard:<invariant>". */
  rule: string;
  tainted: boolean;
  taint: TaintFinding[];
  /** Red warnings (taint explanations). */
  warnings: string[];
  preview: string;
  idempotencyKey: string;
  duplicateOf?: string;
  checks: GuardCheck[];
}

/** Statuses of ledger rows that make a repeated identical call a duplicate. */
const ACTIVE_STATUSES = ["pending_approval", "approved", "held", "executed", "verified", "verification_failed"] as const;
const SEVERITY: Record<GuardDecision, number> = { allow: 0, skip: 1, require_approval: 2, block: 3 };

export interface GuardOptions {
  holdSeconds?: number;
}

export class Guard {
  readonly provenance: ProvenanceStore;
  private readonly holdSeconds: number;

  constructor(private readonly db: Db, private readonly userId: string, opts: GuardOptions = {}) {
    this.provenance = new ProvenanceStore(db, userId);
    this.holdSeconds = opts.holdSeconds ?? 60;
  }

  loadPolicies(): PolicyRule[] {
    const rows = this.db.select().from(schema.policies)
      .where(and(eq(schema.policies.userId, this.userId), eq(schema.policies.enabled, true))).all();
    const out: PolicyRule[] = [];
    for (const r of rows) {
      const parsed = PolicyRule.safeParse(safeJson(r.ruleJson));
      if (parsed.success) out.push({ ...parsed.data, id: r.id });
      // A corrupt rule is skipped: absence of an allow rule only ever makes the Guard stricter.
    }
    return out;
  }

  /** Install default policies for this user (idempotent). */
  seedPolicies() {
    for (const rule of SEED_POLICIES) {
      this.db.insert(schema.policies)
        .values({ id: rule.id, userId: this.userId, ruleJson: JSON.stringify(rule) })
        .onConflictDoNothing().run();
    }
  }

  /** Pure decision: reads state, writes nothing. Deterministic; no LLM. */
  evaluate(call: ProposedCall): GuardResult {
    const checks: GuardCheck[] = [];
    const base = { tool: call.tool, tainted: false, taint: [] as TaintFinding[], warnings: [] as string[], checks, idempotencyKey: "" };
    const blocked = (rule: string, reason: string, extra: Partial<GuardResult> = {}): GuardResult => ({
      ...base, args: {}, tier: null, decision: "block", rule, reason, preview: `Blocked: ${call.tool}`, ...extra,
    });

    // a. known tool, and callable by the agent
    const meta: ToolMeta | undefined = toolMeta(call.tool);
    if (!meta) {
      checks.push({ step: "tool", outcome: "fail", detail: "unknown tool" });
      return blocked("guard:unknown-tool", `Unknown tool “${call.tool}”.`);
    }
    const tier = meta.riskTier;
    if (!meta.agentCallable) {
      checks.push({ step: "tool", outcome: "fail", detail: "tool is Guard-internal (undo-only)" });
      return blocked("guard:not-agent-callable", `“${call.tool}” is an undo-only tool; the agent can never call it.`, { tier });
    }
    if (tier === "R3") {
      checks.push({ step: "tier", outcome: "fail", detail: "R3 is blocked in this prototype" });
      return blocked("guard:r3-blocked", `“${call.tool}” is destructive/financial (R3) and is blocked in this prototype.`, { tier });
    }
    checks.push({ step: "tool", outcome: "pass", detail: `${call.tool} (${tier})` });

    // b. schema validation (strict) + normalization
    const parsed = strictArgSchema(call.tool as ToolName).safeParse(call.args);
    if (!parsed.success) {
      const why = parsed.error.issues.map((i) => `${i.path.join(".") || "args"}: ${i.message}`).join("; ");
      checks.push({ step: "schema", outcome: "fail", detail: why });
      return blocked("guard:schema-validation", `Invalid arguments: ${why}`, { tier });
    }
    const args = normalizeArgs(parsed.data as Record<string, unknown>);
    checks.push({ step: "schema", outcome: "pass", detail: "arguments valid" });

    // c. obligation must exist if referenced
    let obligationConfidence: number | undefined;
    if (call.obligationId) {
      const ob = this.db.select().from(schema.obligations)
        .where(and(eq(schema.obligations.id, call.obligationId), eq(schema.obligations.userId, this.userId))).get();
      if (!ob) {
        checks.push({ step: "obligation", outcome: "fail", detail: "unknown obligation id" });
        return blocked("guard:unknown-obligation", `Obligation “${call.obligationId}” does not exist.`, { tier, args });
      }
      obligationConfidence = ob.confidence;
      checks.push({ step: "obligation", outcome: "pass", detail: `confidence ${ob.confidence}` });
    }

    // d. provenance of sensitive args
    const taint: TaintFinding[] = [];
    for (const name of meta.sensitiveArgs) {
      const raw = args[name];
      const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
      for (const v of values) {
        const trace = this.provenance.trace(String(v), call.runId);
        taint.push({ arg: name, value: trace.value, trusted: trace.trusted, allowlisted: trace.allowlisted, explanation: trace.explanation, trace });
      }
    }
    const tainted = taint.some((t) => !t.trusted);
    const warnings = taint.filter((t) => !t.trusted).map((t) => `${t.arg === "attendees" ? "Attendee" : "Recipient"} ${t.explanation}`);
    const allAllowlisted = taint.every((t) => t.allowlisted);
    checks.push({
      step: "provenance", outcome: tainted ? "fail" : "pass",
      detail: taint.length === 0 ? "no sensitive arguments" : taint.map((t) => `${t.value}: ${t.trusted ? "trusted" : "TAINTED"}`).join("; "),
    });

    // e. idempotency (reads are exempt)
    const idempotencyKey = idempotencyKeyFor(call.tool, args, call.obligationId);
    const preview = buildPreview(this.db, call.tool, args, this.holdSeconds);
    const common = { tool: call.tool, args, tier, tainted, taint, warnings, preview, idempotencyKey, checks };
    if (tier !== "R0") {
      const dup = this.db.select().from(schema.actions)
        .where(and(eq(schema.actions.idempotencyKey, idempotencyKey), inArray(schema.actions.status, [...ACTIVE_STATUSES]))).get();
      if (dup) {
        checks.push({ step: "idempotency", outcome: "fail", detail: `duplicate of action ${dup.id}` });
        return { ...common, decision: "skip", rule: "guard:idempotency", reason: "An identical action for this obligation was already proposed or executed; skipping.", duplicateOf: dup.id };
      }
    }
    checks.push({ step: "idempotency", outcome: "pass", detail: tier === "R0" ? "read-only, exempt" : "new" });

    // f. policy engine (most restrictive matching rule) or tier default
    const { winner, matched } = evaluatePolicies(this.loadPolicies(), {
      tool: call.tool, args, tainted, allSensitiveAllowlisted: allAllowlisted, obligationConfidence,
    });
    let decision: GuardDecision;
    let rule: string;
    let reason: string;
    if (winner) {
      decision = winner.decision; rule = winner.id; reason = winner.reason;
    } else if (tier === "R0") {
      decision = "allow"; rule = "default:r0"; reason = "Read-only call.";
    } else {
      decision = "require_approval"; rule = `default:${tier.toLowerCase()}`; reason = `No policy auto-allows this ${tier} action, so it needs your approval.`;
    }
    checks.push({ step: "policy", outcome: "info", detail: matched.length ? `matched: ${matched.map((m) => `${m.id}→${m.decision}`).join(", ")}` : "no rule matched; tier default applied" });

    // g. hard invariants: these hold even if every policy is deleted or edited.
    const raise = (d: GuardDecision, r: string, why: string) => {
      if (SEVERITY[d] > SEVERITY[decision]) {
        decision = d; rule = r; reason = why;
      }
    };
    const warn = warnings.join(" ");
    if (tier === "R2") raise("require_approval", "guard:r2-needs-approval", "Externally visible actions always need your approval.");
    if (tainted) {
      if (tier === "R2" && !allAllowlisted) {
        raise("block", "guard:tainted-r2-non-allowlisted", `Blocked: ${warn} It is not in your contacts.`);
      } else if (decision === "allow") {
        raise("require_approval", "guard:tainted-no-auto-allow", `Needs approval: ${warn}`);
      }
      if (decision !== "allow" && !reason.includes(warn)) reason = `${reason} WARNING: ${warn}`;
    }
    checks.push({ step: "invariants", outcome: "info", detail: `final: ${decision} by ${rule}` });

    return { ...common, decision, rule, reason };
  }

  /** evaluate() + persist the proposal in the actions ledger and audit log. */
  propose(call: ProposedCall): { actionId: string; result: GuardResult } {
    const result = this.evaluate(call);
    const actionId = `act-${randomUUID().slice(0, 8)}`;
    const tier = result.tier ?? "R3";
    const status = result.decision === "allow" ? "approved"
      : result.decision === "require_approval" ? "pending_approval"
      : result.decision === "block" ? "blocked" : "skipped";
    this.db.insert(schema.actions).values({
      id: actionId, runId: call.runId, obligationId: call.obligationId ?? null, tool: call.tool,
      argsJson: JSON.stringify(result.args), idempotencyKey: result.idempotencyKey || `invalid-${actionId}`,
      riskTier: tier, tainted: result.tainted,
      decision: result.decision === "skip" ? "skipped" : result.decision,
      decisionReason: result.reason, status,
    }).run();
    audit(this.db, { event: "proposed", actor: "agent", runId: call.runId, actionId, detail: { tool: call.tool, args: result.args, obligationId: call.obligationId, preview: result.preview } });
    audit(this.db, { event: result.decision === "skip" ? "skipped" : "decision", actor: "guard", runId: call.runId, actionId, detail: { decision: result.decision, rule: result.rule, reason: result.reason, tainted: result.tainted, warnings: result.warnings, checks: result.checks } });
    return { actionId, result };
  }

  /**
   * The ONLY way an R3/undo-only tool may run: the Guard's own undo path, for artifacts that the ledger
   * records as created by Munshi. The agent can never reach this (evaluate() blocks these tools).
   */
  authorizeUndo(tool: string, args: Record<string, unknown>): { ok: true; actionId: string } | { ok: false; reason: string } {
    const meta = toolMeta(tool);
    if (!meta || meta.agentCallable) return { ok: false, reason: `“${tool}” is not an undo tool.` };
    const parsed = strictArgSchema(tool as ToolName).safeParse(args);
    if (!parsed.success) return { ok: false, reason: "Invalid undo arguments." };
    const a = parsed.data as Record<string, string>;

    const candidates = this.db.select().from(schema.actions)
      .where(inArray(schema.actions.status, ["executed", "verified", "verification_failed"])).all()
      .filter((row) => TOOL_META[row.tool as ToolName] && (TOOL_META[row.tool as ToolName] as ToolMeta).undoTool === tool);
    const match = candidates.find((row) => createdArtifactMatches(row.tool, safeJson(row.argsJson), safeJson(row.resultJson), tool, a));
    if (!match) return { ok: false, reason: `Not undoable: no action in the ledger shows Munshi created this (${tool} ${JSON.stringify(a)}).` };
    return { ok: true, actionId: match.id };
  }
}

function safeJson(s: string | null): any {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

/** Does this ledger row's recorded result prove it created the artifact the undo call targets? */
export function createdArtifactMatches(actionTool: string, actionArgs: any, result: any, undoTool: string, undoArgs: Record<string, string>): boolean {
  switch (undoTool) {
    case "delete_event": return actionTool === "create_event" && result?.event?.id === undoArgs.id;
    case "delete_draft": return actionTool === "create_draft" && result?.draft?.id === undoArgs.id;
    case "remove_label":
      return actionTool === "add_label" && actionArgs?.id === undoArgs.id && actionArgs?.label === undoArgs.label && Boolean(result);
    default: return false;
  }
}

const ADDRESS_ARGS = new Set(["to", "cc", "bcc", "attendees"]);

/** Canonical form: addresses normalized + sorted, strings trimmed. Used for hashing and policy matching. */
export function normalizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(args).sort()) {
    const v = args[k];
    if (ADDRESS_ARGS.has(k) && Array.isArray(v)) out[k] = [...new Set(v.map((x) => normalizeAddress(String(x))))].sort();
    else out[k] = typeof v === "string" ? v.trim() : v;
  }
  return out;
}

export function idempotencyKeyFor(tool: string, normalizedArgs: Record<string, unknown>, obligationId?: string): string {
  return createHash("sha256").update(JSON.stringify([tool, normalizedArgs, obligationId ?? null])).digest("hex");
}
