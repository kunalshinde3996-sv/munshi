import { and, eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { schema } from "../db/index.js";

/** "Name <A@B.com>" → "a@b.com". Exact-or-normalized matching only; no fuzzy matching. */
export function normalizeAddress(v: string): string {
  const m = /<([^>]+)>/.exec(v);
  return (m?.[1] ?? v).trim().toLowerCase();
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;
export const findAddresses = (text: string): string[] => [...new Set((text.match(EMAIL_RE) ?? []).map(normalizeAddress))];

export interface ValueTrace {
  value: string;
  /** Typed by the user in this run's goal, or the user's own account address. */
  userTyped: boolean;
  /** In the user's contacts allowlist. */
  contact: boolean;
  /** Where untrusted content mentioned this value. */
  untrusted: { kind: "email_sender" | "email_content"; emailId: string | null; sender: string | null; subject: string | null; hidden: boolean }[];
  /** Trusted = user-typed, or an allowlisted contact that no untrusted content introduced. */
  trusted: boolean;
  allowlisted: boolean;
  /** Human-readable origin used in UI warnings. */
  explanation: string;
}

export class ProvenanceStore {
  constructor(private readonly db: Db, private readonly userId: string) {}

  /** Trusted: addresses the user typed in the goal for this run. */
  recordGoal(runId: string, goalText: string) {
    for (const value of findAddresses(goalText)) {
      this.db.insert(schema.provenance).values({ userId: this.userId, runId, value, kind: "user_goal", trusted: true }).run();
    }
  }

  /** Untrusted: sender and every address found in an email's content (replaces earlier rows for that email). */
  recordEmail(emailId: string, sender: string, visibleText: string, allText: string) {
    this.db.delete(schema.provenance).where(and(eq(schema.provenance.emailId, emailId), eq(schema.provenance.userId, this.userId))).run();
    const visible = new Set(findAddresses(visibleText));
    const rows = [
      { value: normalizeAddress(sender), kind: "email_sender" as const, hidden: false },
      ...findAddresses(allText).map((value) => ({ value, kind: "email_content" as const, hidden: !visible.has(value) })),
    ];
    for (const r of rows) this.db.insert(schema.provenance).values({ userId: this.userId, emailId, trusted: false, ...r }).run();
  }

  trace(rawValue: string, runId: string): ValueTrace {
    const value = normalizeAddress(rawValue);
    const user = this.db.select().from(schema.users).where(eq(schema.users.id, this.userId)).get();
    const own = user ? normalizeAddress(user.email) === value : false;
    const goal = this.db.select().from(schema.provenance)
      .where(and(eq(schema.provenance.userId, this.userId), eq(schema.provenance.runId, runId), eq(schema.provenance.value, value), eq(schema.provenance.kind, "user_goal")))
      .get();
    const contact = Boolean(
      this.db.select().from(schema.contacts).where(and(eq(schema.contacts.userId, this.userId), eq(schema.contacts.email, value))).get(),
    );
    const untrusted = this.db.select().from(schema.provenance)
      .where(and(eq(schema.provenance.userId, this.userId), eq(schema.provenance.value, value), eq(schema.provenance.trusted, false)))
      .all()
      .map((p) => {
        const e = p.emailId ? this.db.select().from(schema.emails).where(eq(schema.emails.id, p.emailId)).get() : undefined;
        return {
          kind: p.kind as "email_sender" | "email_content", emailId: p.emailId, hidden: p.hidden,
          sender: e?.fromAddr ?? null, subject: e?.subject ?? null,
        };
      });

    const userTyped = own || Boolean(goal);
    const trusted = userTyped || (contact && untrusted.length === 0);
    const allowlisted = own || contact;
    return { value, userTyped, contact, untrusted, trusted, allowlisted, explanation: explain(value, { userTyped, contact, untrusted, trusted }) };
  }
}

function explain(value: string, t: Pick<ValueTrace, "userTyped" | "contact" | "untrusted" | "trusted">): string {
  if (t.trusted) return t.userTyped ? `${value} was typed by you or is your own address.` : `${value} is in your contacts.`;
  const first = t.untrusted[0];
  if (!first) return `${value} does not come from you or your contacts, and its origin is unknown.`;
  const where = first.kind === "email_sender" ? "an email sent by" : first.hidden ? "hidden text in an email from" : "the text of an email from";
  const subj = first.subject ? ` (“${first.subject}”)` : "";
  const more = t.untrusted.length > 1 ? ` and ${t.untrusted.length - 1} more place(s)` : "";
  const base = `${value} appears only in ${where} ${first.sender ?? "an external sender"}${subj}${more}, not from you.`;
  return t.contact ? `${base} (It is in your contacts, but the email introduced it.)` : base;
}
