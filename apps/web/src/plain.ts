// Plain-language layer for the main screens. Pure functions over API data: no LLM, no invented values.
// Internal terms (tool names, tiers, rule ids) stay in "Details" drawers and the Trust view.
import type { Action, EmailRow, Obligation, ObligationType } from "./api";

const IST = "Asia/Kolkata";
const asDate = (due: string) => new Date(due.length === 10 ? `${due}T00:00:00+05:30` : due);

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function money(amount: number | null | undefined, currency: string | null | undefined): string | null {
  if (amount == null) return null;
  const digits = Number.isInteger(amount) ? 0 : 2;
  const figure = amount.toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${currency === "INR" || !currency ? "₹" : `${currency} `}${figure}`;
}

export const shortDate = (due: string) => asDate(due).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: IST });

export function fullDue(due: string | null): string {
  if (!due) return "No date";
  const d = asDate(due);
  const date = d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: IST });
  return due.length === 10 ? date : `${date}, ${d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: IST })}`;
}

/** Whole calendar days (IST) from today to the due date; negative = past. */
export function daysAway(due: string | null, now = Date.now()): number | null {
  if (!due) return null;
  const day = (d: Date) => Date.parse(d.toLocaleDateString("en-CA", { timeZone: IST }));
  const t = asDate(due);
  return Number.isNaN(t.getTime()) ? null : Math.round((day(t) - day(new Date(now))) / 86_400_000);
}

export function relativeDue(due: string | null, now = Date.now()): string {
  const n = daysAway(due, now);
  if (n === null) return "no date";
  if (n === 0) return "today";
  if (n === 1) return "tomorrow";
  if (n === -1) return "yesterday";
  return n < 0 ? `${-n} days ago` : `in ${n} days`;
}

export function groupByDue(obligations: Obligation[], now = Date.now()) {
  const past: Obligation[] = [], week: Obligation[] = [], later: Obligation[] = [];
  for (const o of obligations) {
    const n = daysAway(o.dueDate, now);
    if (n !== null && n < 0) past.push(o);
    else if (n !== null && n <= 7) week.push(o);
    else later.push(o);
  }
  return [
    { id: "past", label: "Past due", items: past },
    { id: "week", label: "This week", items: week },
    { id: "later", label: "Later", items: later },
  ].filter((g) => g.items.length > 0);
}

const NOUN: Record<ObligationType, string> = {
  bill: "bill", deadline: "deadline", renewal: "renewal", refund: "refund", appointment: "appointment", travel: "trip", other: "item",
};

function topic(o: Obligation | undefined): string {
  if (!o) return "";
  const parts = [money(o.amount, o.currency), o.counterparty, NOUN[o.type]].filter(Boolean);
  return ` about your ${parts.join(" ")}`;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
/** Every recipient, never shortened: the user must see who they are approving. */
export const recipients = (args: Record<string, unknown>) => [
  ...strings(args.to),
  ...strings(args.cc).map((x) => `${x} (cc)`),
  ...strings(args.bcc).map((x) => `${x} (bcc)`),
];

type AskAction = Pick<Action, "tool" | "args" | "preview">;

/** The one-sentence question on an approval card, built from the exact arguments that would run. */
export function askSentence(a: AskAction, o: Obligation | undefined, emails: EmailRow[] = []): string {
  const args = a.args ?? {};
  switch (a.tool) {
    case "create_draft":
      return `Save a draft to ${recipients(args).join(", ")}${topic(o)}?`;
    case "send_email":
      return `Send an email to ${recipients(args).join(", ")}${topic(o)}?`;
    case "create_event": {
      const who = strings(args.attendees);
      return `Add “${String(args.title)}” to your calendar on ${shortDate(String(args.start))}${who.length ? ` and invite ${who.join(", ")}` : ""}?`;
    }
    case "add_label": {
      const subject = emails.find((e) => e.id === args.id)?.subject;
      return `Label ${subject ? `“${subject}”` : "this email"} as “${String(args.label)}”?`;
    }
    default:
      return `${a.preview ?? "Allow this action"}?`;
  }
}

/** Short line under a finished item. */
export function doneTitle(a: Pick<Action, "tool" | "args" | "preview">, emails: EmailRow[] = []): string {
  const args = a.args ?? {};
  switch (a.tool) {
    case "create_event": return String(args.title);
    case "create_draft": return `Draft to ${recipients(args).join(", ")}`;
    case "send_email": return `Email to ${recipients(args).join(", ")}`;
    case "add_label": return `“${String(args.label)}” on ${emails.find((e) => e.id === args.id)?.subject ?? "an email"}`;
    default: return a.preview ?? "Action";
  }
}

/** One short warning for a tainted action; the full provenance explanation is behind "Why?". */
export function taintLine(a: Pick<Action, "taint">): string {
  const untrusted = a.taint.filter((t) => !t.trusted);
  const many = untrusted.length > 1;
  // Never claim "from the email" unless provenance actually found the value in an email.
  const allFromEmail = untrusted.length > 0 && untrusted.every((t) => (t.origins?.length ?? 0) > 0);
  if (allFromEmail) return many ? "These addresses came from email, not from you." : "This address came from the email, not from you.";
  return many ? "These addresses aren't from you or your contacts." : "This address isn't from you or your contacts.";
}

const DONE_NOUN: Record<string, [string, string, string]> = {
  create_event: ["reminder", "reminders", "added"],
  create_draft: ["draft", "drafts", "saved"],
  add_label: ["label", "labels", "added"],
  send_email: ["email", "emails", "sent"],
};

export function handledLabel(done: Pick<Action, "tool">[]): string {
  const counts = new Map<string, number>();
  for (const a of done) counts.set(a.tool, (counts.get(a.tool) ?? 0) + 1);
  return [...counts]
    .map(([tool, n]) => {
      const [one, many, verb] = DONE_NOUN[tool] ?? ["action", "actions", "done"];
      return `${plural(n, one, many)} ${verb}`;
    })
    .join(", ");
}

/** Flagged emails split by outcome: "blocked" only when nothing at all was taken from the email. */
export function suspiciousEmails(emails: EmailRow[]) {
  const flagged = emails.filter(
    (e) => e.flags && (e.flags.hiddenContent.some((h) => h.suspicious !== false) || e.flags.injectionSuspected.length || e.flags.rejectedObligations.length),
  );
  const blocked = flagged.filter((e) => e.obligationCount === 0);
  return { flagged, blocked };
}

export function shieldLabel(emails: EmailRow[], blockedActions = 0): string | null {
  const { flagged, blocked } = suspiciousEmails(emails);
  const parts: string[] = [];
  if (blocked.length) parts.push(`${plural(blocked.length, "suspicious email")} blocked`);
  const onlyFlagged = flagged.length - blocked.length;
  if (onlyFlagged) parts.push(blocked.length ? `${onlyFlagged} flagged` : `${plural(onlyFlagged, "suspicious email")} flagged`);
  if (blockedActions) parts.push(`${plural(blockedActions, "action")} blocked`);
  return parts.join(", ") || null;
}

export interface BriefFacts {
  scanned: boolean;
  /** There are obligations Munshi has not yet proposed anything for, and nothing is in progress. */
  readyToHandle: boolean;
  needs: number;
  handled: number;
  problems: number;
  comingUp: number;
  stopped: number;
}

/** The home screen headline. Every number comes from the API. */
export function brief(f: BriefFacts): string {
  if (!f.scanned) return "Ready when you are.";
  const out: string[] = [];
  if (f.needs) out.push(`${plural(f.needs, "thing")} ${f.needs === 1 ? "needs" : "need"} you.`);
  else if (f.readyToHandle && !f.handled) out.push(f.comingUp ? `${plural(f.comingUp, "thing")} coming up.` : "Nothing coming up.");
  else out.push("Nothing needs you.");
  if (f.handled) out.push(`${f.handled} ${f.handled === 1 ? "is" : "are"} handled.`);
  if (f.problems) out.push(`${f.problems} ${f.problems === 1 ? "needs" : "need"} a check.`);
  if (f.stopped) out.push(`Munshi stopped ${plural(f.stopped, "suspicious email")}.`);
  return out.join(" ");
}
