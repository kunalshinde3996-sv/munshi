import type { Db } from "./db/index.js";
import { schema } from "./db/index.js";

export type AuditEvent = (typeof schema.auditLog.$inferInsert)["event"];

/** Append-only audit writer. This is the ONLY place application code writes to audit_log (INSERT only). */
export function audit(
  db: Db,
  e: { event: AuditEvent; actor: "agent" | "guard" | "user" | "system"; runId?: string; actionId?: string; detail: unknown },
) {
  db.insert(schema.auditLog)
    .values({
      event: e.event, actor: e.actor, runId: e.runId ?? null, actionId: e.actionId ?? null,
      detail: JSON.stringify(e.detail),
    })
    .run();
}
