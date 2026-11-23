import { z } from "zod";

const Scalar = z.union([z.string(), z.number(), z.boolean()]);

/** Condition on one argument: literal equality, or a small operator object. */
export const ArgCondition = z.union([
  Scalar,
  z.object({ contains: z.string() }).strict(),
  z.object({ gte: z.number() }).strict(),
  z.object({ lte: z.number() }).strict(),
  z.object({ in: z.array(Scalar) }).strict(),
  z.object({ exists: z.boolean() }).strict(),
]);
export type ArgCondition = z.infer<typeof ArgCondition>;

export const PolicyDecision = z.enum(["allow", "require_approval", "block"]);
export type PolicyDecision = z.infer<typeof PolicyDecision>;

export const PolicyRule = z
  .object({
    id: z.string().min(1).max(80),
    description: z.string().max(300).optional(),
    match: z
      .object({
        /** Tool name, or "*" for any tool. */
        tool: z.string().min(1),
        argsCondition: z.record(z.string(), ArgCondition).optional(),
        /** Taint state computed by the Guard's provenance check. */
        tainted: z.boolean().optional(),
        /** True iff every sensitive-arg value is the user's own address or an allowlisted contact. */
        allSensitiveAllowlisted: z.boolean().optional(),
        /** Confidence of the obligation the call was proposed for (call without an obligation never matches). */
        minObligationConfidence: z.number().min(0).max(1).optional(),
      })
      .strict(),
    decision: PolicyDecision,
    reason: z.string().min(1).max(300),
  })
  .strict();
export type PolicyRule = z.infer<typeof PolicyRule>;

export interface PolicyFacts {
  tool: string;
  args: Record<string, unknown>;
  tainted: boolean;
  allSensitiveAllowlisted: boolean;
  obligationConfidence?: number;
}

const norm = (s: string) => s.trim().toLowerCase();

function conditionHolds(cond: ArgCondition, value: unknown): boolean {
  if (typeof cond === "object") {
    if ("exists" in cond) return (value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0)) === cond.exists;
    if (value === undefined || value === null) return false;
    if ("gte" in cond) return typeof value === "number" && value >= cond.gte;
    if ("lte" in cond) return typeof value === "number" && value <= cond.lte;
    if ("in" in cond) return cond.in.some((c) => (typeof c === "string" && typeof value === "string" ? norm(c) === norm(value) : c === value));
    if ("contains" in cond) {
      const needle = norm(cond.contains);
      if (Array.isArray(value)) return value.some((v) => typeof v === "string" && norm(v).includes(needle));
      return typeof value === "string" && norm(value).includes(needle);
    }
    return false;
  }
  if (typeof cond === "string" && typeof value === "string") return norm(cond) === norm(value);
  return cond === value;
}

export function ruleMatches(rule: PolicyRule, f: PolicyFacts): boolean {
  const m = rule.match;
  if (m.tool !== "*" && m.tool !== f.tool) return false;
  if (m.tainted !== undefined && m.tainted !== f.tainted) return false;
  if (m.allSensitiveAllowlisted !== undefined && m.allSensitiveAllowlisted !== f.allSensitiveAllowlisted) return false;
  if (m.minObligationConfidence !== undefined) {
    if (f.obligationConfidence === undefined || f.obligationConfidence < m.minObligationConfidence) return false;
  }
  for (const [key, cond] of Object.entries(m.argsCondition ?? {})) {
    if (!conditionHolds(cond, f.args[key])) return false;
  }
  return true;
}

const SEVERITY: Record<PolicyDecision, number> = { allow: 0, require_approval: 1, block: 2 };

/** All matching rules; the most restrictive wins (block > require_approval > allow). Ties: first in list. */
export function evaluatePolicies(rules: PolicyRule[], f: PolicyFacts): { winner: PolicyRule | null; matched: PolicyRule[] } {
  const matched = rules.filter((r) => ruleMatches(r, f));
  let winner: PolicyRule | null = null;
  for (const r of matched) if (!winner || SEVERITY[r.decision] > SEVERITY[winner.decision]) winner = r;
  return { winner, matched };
}

/** Defaults seeded for every user. Visible and editable on the Policies page; hard Guard invariants don't depend on them. */
export const SEED_POLICIES: PolicyRule[] = [
  {
    id: "seed-never-auto-send",
    description: "Email is never sent without your approval.",
    match: { tool: "send_email" },
    decision: "require_approval",
    reason: "Sending email is externally visible, so it always needs your approval.",
  },
  {
    id: "seed-block-tainted-send",
    description: "Block sending to recipients that came from email content and are not in your contacts.",
    match: { tool: "send_email", tainted: true, allSensitiveAllowlisted: false },
    decision: "block",
    reason: "Recipient comes from untrusted email content and is not in your contacts.",
  },
  {
    id: "seed-auto-calendar-reminders",
    description: "Calendar reminders for obligations extracted with confidence >= 0.8 are created automatically (and are undoable).",
    match: { tool: "create_event", minObligationConfidence: 0.8 },
    decision: "allow",
    reason: "Reversible calendar reminder for a high-confidence obligation.",
  },
  {
    id: "seed-auto-drafts",
    description: "Drafts are not sent, so they are created automatically (and are undoable).",
    match: { tool: "create_draft" },
    decision: "allow",
    reason: "Drafts are reversible and never leave your mailbox.",
  },
];
