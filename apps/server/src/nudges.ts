import { and, eq, inArray, isNull } from "drizzle-orm";
import { schema, type Db } from "./db/index.js";
import { currentMode } from "./scan.js";

export const NUDGE_WINDOW_MS = 48 * 3600_000;

/** Action statuses that mean "Munshi is already dealing with this obligation". */
const HANDLED = ["pending_approval", "approved", "held", "executed", "verified"] as const;

/** Due instant of an obligation: date-only values are due at the end of that day in IST. */
export function dueAtMs(due: string | null): number | null {
  if (!due) return null;
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(due) ? `${due}T23:59:59+05:30` : due);
  return Number.isNaN(t) ? null : t;
}

export interface Nudge {
  obligationId: string;
  title: string;
  type: string;
  dueDate: string | null;
  dueAt: number;
  amount: number | null;
  currency: string | null;
  counterparty: string | null;
  createdAt: number;
}

/** Obligations due within 48h (and not already past) that no action is handling. Deterministic, no LLM. */
export function dueSoonUnhandled(db: Db, now = Date.now()) {
  const handled = new Set(
    db.select({ o: schema.actions.obligationId }).from(schema.actions).where(inArray(schema.actions.status, [...HANDLED])).all().map((r) => r.o),
  );
  const mode = currentMode(db);
  return db
    .select({ o: schema.obligations, source: schema.emails.source })
    .from(schema.obligations)
    .innerJoin(schema.emails, eq(schema.obligations.emailId, schema.emails.id))
    .where(eq(schema.emails.source, mode))
    .all()
    .map((r) => r.o)
    .filter((o) => {
      const t = dueAtMs(o.dueDate);
      return t !== null && t >= now && t <= now + NUDGE_WINDOW_MS && !handled.has(o.id);
    });
}

/** Creates a nudge row for every due-soon, unhandled obligation that has none yet. Returns the newly created ones. */
export function syncNudges(db: Db, now = Date.now()) {
  const created: typeof schema.obligations.$inferSelect[] = [];
  for (const o of dueSoonUnhandled(db, now)) {
    const r = db.insert(schema.notifications).values({ kind: "nudge", refId: o.id, createdAt: now }).onConflictDoNothing().run();
    if (r.changes) created.push(o);
  }
  return created;
}

/** Open nudges for the UI: created, and still due soon + unhandled right now. */
export function listNudges(db: Db, now = Date.now()): Nudge[] {
  const open = new Map(dueSoonUnhandled(db, now).map((o) => [o.id, o]));
  return db
    .select()
    .from(schema.notifications)
    .where(eq(schema.notifications.kind, "nudge"))
    .all()
    .flatMap((n) => {
      const o = open.get(n.refId);
      return o
        ? [{ obligationId: o.id, title: o.title, type: o.type, dueDate: o.dueDate, dueAt: dueAtMs(o.dueDate)!, amount: o.amount, currency: o.currency, counterparty: o.counterparty, createdAt: n.createdAt }]
        : [];
    })
    .sort((a, b) => a.dueAt - b.dueAt);
}

export const unsentNudgeObligations = (db: Db) =>
  db
    .select({ n: schema.notifications, o: schema.obligations })
    .from(schema.notifications)
    .innerJoin(schema.obligations, eq(schema.notifications.refId, schema.obligations.id))
    .where(and(eq(schema.notifications.kind, "nudge"), isNull(schema.notifications.telegramSentAt)))
    .all();
