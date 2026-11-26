import { describe, expect, it } from "vitest";
import type { Action, EmailRow, Obligation } from "./api";
import { askSentence, brief, daysAway, groupByDue, handledLabel, money, shieldLabel, taintLine } from "./plain";

const refund: Obligation = {
  id: "o1", emailId: "e1", type: "refund", title: "Amazon refund pending", dueDate: "2026-11-29", amount: 2499, currency: "INR",
  counterparty: "Amazon", confidence: 0.7, evidenceQuote: "q", emailFrom: "a@x.example", emailSubject: "s", emailSource: "sandbox",
};
const ask = (tool: string, args: Record<string, unknown>) => askSentence({ tool, args, preview: null }, refund);
const taint = (...origins: ({ emailId: string }[] | undefined)[]) =>
  ({ taint: origins.map((o, i) => ({ arg: "to", value: `v${i}`, trusted: false, allowlisted: false, explanation: "", origins: o })) }) satisfies Pick<Action, "taint">;
const email = (id: string, obligationCount: number): EmailRow => ({
  id, from: "x@y.example", subject: id, receivedAt: 0, source: "sandbox", status: "done", error: null, obligationCount,
  flags: { hiddenContent: [], injectionSuspected: [{ pattern: "p", text: "t", where: "visible" }], rejectedObligations: [] },
});

describe("approval sentence", () => {
  it("names every recipient in full, including cc and bcc", () => {
    const s = ask("send_email", { to: ["one@a-very-long-domain.example"], cc: ["two@b.example"], bcc: ["three@c.example"] });
    expect(s).toBe("Send an email to one@a-very-long-domain.example, two@b.example (cc), three@c.example (bcc) about your ₹2,499 Amazon refund?");
  });
  it("says a draft is a draft, not a send", () => {
    expect(ask("create_draft", { to: ["r@a.example"] })).toMatch(/^Save a draft to r@a\.example /);
  });
  it("shows the event title that would be created and who gets invited", () => {
    expect(ask("create_event", { title: "Pay it", start: "2026-11-29T09:00:00+05:30", attendees: ["g@a.example"] }))
      .toBe("Add “Pay it” to your calendar on 29 Nov and invite g@a.example?");
  });
});

describe("address warning", () => {
  it("claims an email origin only when provenance found one", () => {
    expect(taintLine(taint([{ emailId: "e1" }]))).toBe("This address came from the email, not from you.");
    expect(taintLine(taint([]))).toBe("This address isn't from you or your contacts.");
    expect(taintLine(taint([{ emailId: "e1" }], []))).toBe("These addresses aren't from you or your contacts.");
  });
});

describe("home brief", () => {
  const facts = { scanned: true, readyToHandle: false, needs: 2, handled: 5, problems: 0, comingUp: 9, stopped: 2 };
  it("answers what needs me and what is handled", () => {
    expect(brief(facts)).toBe("2 things need you. 5 are handled. Munshi stopped 2 suspicious emails.");
  });
  it("never hides a failed check", () => {
    expect(brief({ ...facts, needs: 0, problems: 1 })).toContain("1 needs a check.");
  });
  it("does not say nothing needs you before Munshi has looked at what is coming", () => {
    expect(brief({ ...facts, needs: 0, handled: 0, stopped: 0, readyToHandle: true })).toBe("9 things coming up.");
  });
  it("says blocked only for emails nothing was taken from", () => {
    expect(shieldLabel([email("a", 0), email("b", 1)])).toBe("1 suspicious email blocked, 1 flagged");
    expect(shieldLabel([email("b", 1)])).toBe("1 suspicious email flagged");
    expect(shieldLabel([])).toBeNull();
  });
  it("labels handled work by kind", () => {
    expect(handledLabel([{ tool: "create_event" }, { tool: "create_event" }, { tool: "create_draft" }])).toBe("2 reminders added, 1 draft saved");
  });
});

describe("dates and money", () => {
  const now = Date.parse("2026-11-26T23:00:00+05:30");
  it("counts calendar days in IST", () => {
    expect(daysAway("2026-11-27T00:30:00+05:30", now)).toBe(1);
    expect(daysAway("2026-11-26", now)).toBe(0);
  });
  it("keeps overdue and undated items visible", () => {
    const g = groupByDue([{ ...refund, dueDate: "2026-11-20" }, { ...refund, dueDate: null }, refund], now);
    expect(g.map((x) => [x.id, x.items.length])).toEqual([["past", 1], ["week", 1], ["later", 1]]);
  });
  it("shows two decimals for fractional amounts", () => {
    expect(money(18432.6, "INR")).toBe("₹18,432.60");
    expect(money(649, null)).toBe("₹649");
  });
});
