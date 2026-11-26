// Plain-language layer for the main screens. Pure functions over API data: no LLM, no invented values.
// Internal terms (tool names, tiers, rule ids) stay in "Details" drawers and the Trust view.
import type { Action, AuditEntry, EmailRow, Obligation, ObligationType } from "./api";

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

// ---- what a decision card and its toast say, from the server's answer ----

export type Outcome = {
  /** What the card's buttons turn into. */
  button: string;
  toast: string;
  ok: boolean;
  /** "server": POST undo (only when the server says the action can be undone). "unsnooze": bring the card back. */
  undo: { kind: "server" | "unsnooze"; label: string } | null;
};

export function decisionOutcome(choice: "approve" | "reject" | "snooze", result: Action, emails: EmailRow[] = []): Outcome {
  if (choice === "snooze") return { button: "Set aside", toast: "Set aside. It's still waiting.", ok: true, undo: { kind: "unsnooze", label: "Bring back" } };
  // A rejection cannot be taken back: there is no API for it, so no Undo is offered.
  if (choice === "reject") return { button: "✓ Rejected", toast: "Rejected. Nothing was done.", ok: true, undo: null };
  const undo = result.canUndo ? { kind: "server" as const, label: result.undoHint ?? "Undo" } : null;
  const title = doneTitle(result, emails);
  switch (result.status) {
    case "failed": return { button: "Didn't work", toast: `Approved, but it didn't work: ${title}`, ok: false, undo };
    case "verification_failed": return { button: "Couldn't confirm", toast: `Approved, but couldn't confirm it worked: ${title}`, ok: false, undo };
    case "held": return { button: "✓ Approved", toast: `Approved, waiting to send: ${title}`, ok: true, undo };
    default: return { button: "✓ Approved", toast: `Approved: ${title}`, ok: true, undo };
  }
}

/** Obligations due today through the next seven days (the same window as the "This week" group). */
export const dueThisWeek = (obligations: Obligation[], now = Date.now()) =>
  obligations.filter((o) => {
    const n = daysAway(o.dueDate, now);
    return n !== null && n >= 0 && n <= 7;
  }).length;

// ---- Trust view: one status, one reason, plain audit sentences ----

export type StatusTone = "green" | "amber" | "darkred" | "stone" | "blue";

/** Where an action ended up, and who let it through. Not the Guard's first decision. */
export function finalStatus(a: Pick<Action, "status" | "decision" | "holdUntil">, now = Date.now()): { text: string; tone: StatusTone } {
  // An action the Guard held for approval can only move on through the user's approve or reject.
  const who = a.decision === "require_approval" ? "Approved by you" : "Allowed automatically";
  switch (a.status) {
    case "pending_approval": return { text: "Waiting for you", tone: "amber" };
    case "rejected": return { text: "Rejected", tone: "stone" };
    case "blocked": return { text: "Blocked", tone: "darkred" };
    case "skipped": return { text: "Skipped (duplicate)", tone: "stone" };
    case "verified": return { text: `${who} · Verified ✓`, tone: "green" };
    case "verification_failed": return { text: `${who} · Check failed ✗`, tone: "darkred" };
    case "failed": return { text: `${who} · Failed ✗`, tone: "darkred" };
    case "held": return { text: `${who} · Sends in ${Math.max(0, Math.ceil(((a.holdUntil ?? now) - now) / 1000))}s`, tone: "blue" };
    case "undone": return { text: `${who} · Undone`, tone: "stone" };
    case "executed": return { text: `${who} · Checking…`, tone: "blue" };
    case "approved": return { text: `${who} · Running…`, tone: "blue" };
    default: return { text: a.status, tone: "stone" };
  }
}

/** The single short line a card may show about why it deserves attention. Null when there is nothing to say. */
export function shortFlag(a: Pick<Action, "tainted" | "taint" | "status">): string | null {
  if (a.tainted) {
    const untrusted = a.taint.filter((t) => !t.trusted);
    const many = untrusted.length > 1;
    if (untrusted.length > 0 && untrusted.every((t) => (t.origins?.length ?? 0) > 0))
      return many ? "Addresses came from email, not from you" : "Address came from an email, not from you";
    return many ? "Addresses aren't from you or your contacts" : "Address isn't from you or your contacts";
  }
  if (a.status === "blocked") return "Stopped by a safety rule";
  if (a.status === "failed") return "This didn't work";
  if (a.status === "verification_failed") return "Couldn't confirm this worked";
  return null;
}

/** The Guard's reason minus the provenance text, which Details already shows once. */
export function reasonWithoutProvenance(a: Pick<Action, "reason" | "warnings" | "taint">): string {
  // Warnings first: each one is an explanation with a "Recipient" or "Attendee" prefix.
  const repeated = [...a.warnings, ...a.taint.filter((t) => !t.trusted).map((t) => t.explanation)];
  return repeated
    .reduce((s, text) => s.split(text).join(" "), a.reason)
    .replace(/WARNING:/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/:$/, "");
}

/** "reminder: BESCOM bill due", "draft to a@b.example". Null when the arguments don't say. */
function thing(tool: string, args: Record<string, unknown>, emails: EmailRow[]): string | null {
  const to = recipients(args).join(", ");
  switch (tool) {
    case "create_event": return args.title ? `reminder: ${String(args.title)}` : null;
    case "create_draft": return to ? `draft to ${to}` : null;
    case "send_email": return to ? `email to ${to}` : null;
    case "add_label": {
      const subject = emails.find((e) => e.id === args.id)?.subject;
      return args.label ? `label “${String(args.label)}”${subject ? ` on “${subject}”` : ""}` : null;
    }
    default: return null;
  }
}

/** One-line title for an action card. */
export function shortTitle(a: Pick<Action, "tool" | "args" | "preview">, emails: EmailRow[] = []): string {
  const t = thing(a.tool, a.args ?? {}, emails);
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : (a.preview ?? a.tool);
}

type Json = Record<string, any>;
export type ActionRef = { tool: string; args: Json };

/** What each audit entry is about: the action list, falling back to the "proposed" entries in the log itself. */
export function auditRefs(entries: AuditEntry[], actions: Pick<Action, "id" | "tool" | "args">[]): Map<string, ActionRef> {
  const refs = new Map<string, ActionRef>();
  for (const e of entries) {
    const d = (e.detail ?? {}) as Json;
    if (e.event === "proposed" && e.actionId) refs.set(e.actionId, { tool: d.tool, args: d.args ?? {} });
  }
  for (const a of actions) refs.set(a.id, { tool: a.tool, args: a.args ?? {} });
  return refs;
}

/** A plain sentence for one audit row. The raw entry stays available next to it. */
export function auditSentence(e: AuditEntry, refs: Map<string, ActionRef>, emails: EmailRow[] = []): string {
  const d = (e.detail ?? {}) as Json;
  const ref = e.actionId ? refs.get(e.actionId) : undefined;
  const what = ref ? (thing(ref.tool, ref.args, emails) ?? `a ${ref.tool} call`) : "an action";
  const mail = () => {
    const subject = emails.find((m) => m.id === d.emailId)?.subject;
    return subject ? `“${subject}”` : "an email";
  };
  const via = d.channel === "telegram" ? " on Telegram" : "";
  switch (e.event) {
    case "proposed": return `Munshi proposed ${what}`;
    case "decision":
      if (d.google) return `You ${d.google} Google`;
      if (d.mode) return `You switched to ${d.mode === "google" ? "Google" : "sandbox"} mail`;
      if (d.decision === "allow") return `Guard allowed ${what}`;
      if (d.decision === "require_approval") return `Guard asked you about ${what}`;
      if (d.decision === "block") return `Guard blocked ${what}`;
      return `Guard decided on ${what}`;
    case "skipped": return `Guard skipped a duplicate ${what}`;
    case "approved":
      // The system releasing a held send is not a second approval by the user.
      return d.releasedAfterHold ? `Wait ended, going ahead with ${what}` : `You approved ${what}${via}`;
    case "rejected": return `You rejected ${what}${via}`;
    case "held": return `Waiting ${d.holdSeconds}s before carrying out ${what}`;
    case "executed": return `Munshi carried out ${what}`;
    case "verified": return `Read-back confirmed ${what}`;
    case "verification_failed": return `Read-back did not match ${what}`;
    case "undone":
      if (d.how) return `You cancelled ${what}; nothing was sent`;
      return `You undid ${what}${d.verified?.ok === false ? " (removal not confirmed)" : ""}`;
    case "failed":
      if (d.undo === "refused") return `Guard refused to undo ${what}`;
      if (d.kind === "extraction_failed") return `Couldn't read ${mail()}`;
      if (d.run) return "A Munshi run failed";
      return `Failed: ${what}`;
    case "hidden_content_detected": return `Hidden text found in ${mail()}`;
    case "injection_suspected": return d.injection?.length ? `Possible injected instructions in ${mail()}` : `Rejected AI output from ${mail()}`;
    case "policy_proposed": return `A rule was drafted: “${d.text}”`;
    case "policy_confirmed": return `You confirmed a rule: “${d.text}”`;
    case "login": return d.method === "demo_account" ? "You signed in with the demo account" : "You signed in";
    case "login_failed": return `Failed sign-in for ${d.email}`;
    case "logout": return "You signed out";
    default: return e.event.replace(/_/g, " ");
  }
}
