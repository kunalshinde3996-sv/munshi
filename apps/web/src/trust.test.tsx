// Trust view: one reason, once; final status; plain audit sentences. Renders the real components to static markup.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActionCard } from "./ActionRecord";
import type { Action, AuditEntry, SecurityEmail } from "./api";
import { AuditLog, SuspiciousEmail } from "./pages/Security";
import { auditRefs, auditSentence, finalStatus, reasonWithoutProvenance, shortFlag, shortTitle } from "./plain";

const ADDRESS = "refunds@amazon-support.example";
const EXPLANATION = `${ADDRESS} appears only in an email sent by ${ADDRESS}, not from you.`;
const WARNING = `Recipient ${EXPLANATION}`;
const tainted: Action = {
  id: "act-1", runId: "run-1", obligationId: "o1", tool: "create_draft", tier: "R1",
  args: { to: [ADDRESS], subject: "Where is my refund?", body: "b" }, tainted: true, decision: "require_approval",
  reason: `Needs approval: ${WARNING}`, rule: "guard:tainted-no-auto-allow", status: "pending_approval",
  preview: `Create a DRAFT “Where is my refund?” to ${ADDRESS}`, warnings: [WARNING],
  taint: [{ arg: "to", value: ADDRESS, trusted: false, allowlisted: false, explanation: EXPLANATION, origins: [{ emailId: "e1", subject: "Refund", hidden: false }] }],
  holdUntil: null, result: null, verify: null, createdAt: 0, canUndo: false, undoHint: null,
};

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;
const card = renderToStaticMarkup(<ActionCard a={tainted} now={0} onOpenEmail={() => undefined} />);
const visible = card.slice(0, card.indexOf("<details"));

describe("action card", () => {
  it("shows only a title, one short line and the status by default", () => {
    expect(visible).toContain(`Draft to ${ADDRESS}`);
    expect(visible).toContain("Address came from an email, not from you");
    expect(visible).toContain("Waiting for you");
    for (const hidden of ["guard:tainted-no-auto-allow", "create_draft", "R1", "appears only in", "Open source email"]) expect(visible).not.toContain(hidden);
  });
  it("keeps the full record in a collapsed Details, with the provenance text exactly once", () => {
    expect(card).not.toMatch(/<details[^>]*\sopen/);
    expect(count(card, "appears only in an email sent by")).toBe(1);
    for (const kept of ["guard:tainted-no-auto-allow", "create_draft", "R1", "Open source email"]) expect(card).toContain(kept);
  });
  it("does not print a reason that only repeats the decision", () => {
    expect(card).not.toContain("Guard&#x27;s reason");
    const why = renderToStaticMarkup(<ActionCard a={{ ...tainted, reason: `Blocked: ${WARNING} It is not in your contacts.` }} now={0} onOpenEmail={() => undefined} />);
    expect(why).toContain("Blocked: It is not in your contacts.");
  });
  it("strips only the repeated provenance from the Guard's reason", () => {
    expect(reasonWithoutProvenance(tainted)).toBe("Needs approval");
    expect(reasonWithoutProvenance({ ...tainted, reason: `Blocked: ${WARNING} It is not in your contacts.` })).toBe("Blocked: It is not in your contacts.");
    expect(reasonWithoutProvenance({ ...tainted, reason: `My own rule. WARNING: ${WARNING}` })).toBe("My own rule.");
    expect(reasonWithoutProvenance({ reason: "Unknown tool.", warnings: [], taint: [] })).toBe("Unknown tool.");
  });
  it("has no warning line for a clean action and falls back to the preview when arguments are missing", () => {
    expect(shortFlag({ tainted: false, taint: [], status: "verified" })).toBeNull();
    expect(shortTitle({ tool: "send_email", args: {}, preview: "Blocked: send_email" })).toBe("Blocked: send_email");
  });
});

describe("final status", () => {
  const text = (status: string, decision: Action["decision"] = "require_approval") => finalStatus({ status, decision, holdUntil: 61_000 }, 1000).text;
  it("says how it ended, not what the Guard first decided", () => {
    expect(text("verified")).toBe("Approved by you · Verified ✓");
    expect(text("verified", "allow")).toBe("Allowed automatically · Verified ✓");
    expect(text("pending_approval")).toBe("Waiting for you");
    expect(text("rejected")).toBe("Rejected");
    expect(text("blocked", "block")).toBe("Blocked");
    expect(text("held")).toBe("Approved by you · Sends in 60s");
  });
  it("never reports a failed read-back as verified", () => {
    expect(text("verification_failed")).toBe("Approved by you · Check failed ✗");
  });
});

describe("audit log", () => {
  const entry = (event: string, detail: unknown, actionId: string | null = "act-1"): AuditEntry => ({ id: 7, ts: 0, runId: null, actionId, event, actor: "guard", detail });
  const refs = auditRefs([entry("proposed", { tool: "create_event", args: { title: "BESCOM bill due (₹1,847)" } }, "act-2")], [tainted]);
  const say = (event: string, detail: unknown, id?: string | null) => auditSentence(entry(event, detail, id), refs);

  it("writes a plain sentence per entry", () => {
    expect(say("decision", { decision: "allow" }, "act-2")).toBe("Guard allowed reminder: BESCOM bill due (₹1,847)");
    expect(say("approved", { approvedBy: "user", channel: "web" })).toBe(`You approved draft to ${ADDRESS}`);
    expect(say("approved", { channel: "telegram" })).toContain("on Telegram");
  });
  it("does not credit the user with the system releasing a held send", () => {
    expect(say("approved", { releasedAfterHold: true })).not.toContain("You approved");
  });
  it("reports an unconfirmed undo", () => {
    expect(say("undone", { verified: { ok: false } })).toContain("(removal not confirmed)");
  });
  it("is collapsed by default and shows the entry count", () => {
    const html = renderToStaticMarkup(<AuditLog entries={[entry("login", {}, null)]} actions={[]} emails={[]} />);
    expect(html).toContain("Audit log · 1 entry");
    expect(html).toContain("Append-only, enforced by the database.");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("You signed in");
  });
});

describe("suspicious email card", () => {
  const email: SecurityEmail = {
    id: "e1", from: "x@y.example", subject: "Deals", source: "sandbox",
    flags: { hiddenContent: [], rejectedObligations: [], injectionSuspected: [{ pattern: "p", text: "first order", where: "hidden" }, { pattern: "p", text: "second order", where: "visible" }] },
  };
  it("shows one truncated quote with a way to expand", () => {
    const html = renderToStaticMarkup(<SuspiciousEmail e={email} nothingTaken onOpen={() => undefined} />);
    expect(html).toContain("truncate");
    expect(html).toContain("first order");
    expect(html).not.toContain("second order");
    expect(html).toContain("Show what it tried");
  });
});
