import { SANDBOX_USER_EMAIL } from "@munshi/mcp-common";
import { desc, eq } from "drizzle-orm";
import { audit } from "./audit.js";
import { schema, type Db } from "./db/index.js";
import { Guard } from "./guard/guard.js";
import { ProvenanceStore } from "./guard/provenance.js";
import { extractObligations, type RawEmail, type SecurityFlags } from "./extraction/extractor.js";
import type { LlmAdapter } from "./llm/types.js";
import type { McpHub } from "./mcp/hub.js";

export const USER_ID = "local";

export function ensureUser(db: Db) {
  db.insert(schema.users).values({ id: USER_ID, email: SANDBOX_USER_EMAIL, mode: "sandbox" }).onConflictDoNothing().run();
  new Guard(db, USER_ID).seedPolicies();
}

export interface ScanSummary {
  listed: number;
  skipped: number;
  extracted: number;
  failed: number;
  obligations: number;
  hiddenContentEmails: number;
  injectionEmails: number;
}

export interface ScanOptions {
  db: Db;
  mcp: McpHub;
  llm: LlmAdapter;
  /** Re-extract emails that already have status "done". */
  force?: boolean;
  now?: Date;
  onProgress?: (msg: string) => void;
}

/** List inbox via MCP → quarantined extraction per email → persist obligations, flags and failures. */
export async function scanInbox({ db, mcp, llm, force = false, now = new Date(), onProgress }: ScanOptions): Promise<ScanSummary> {
  ensureUser(db);
  const listed = await mcp.callTool("list_recent_emails", { limit: 50 });
  const source = listed.source as "sandbox" | "google";
  const summaries = (listed.emails as { id: string; labels: string[] }[]).filter((e) => !e.labels.includes("SENT"));
  const out: ScanSummary = {
    listed: summaries.length, skipped: 0, extracted: 0, failed: 0, obligations: 0,
    hiddenContentEmails: 0, injectionEmails: 0,
  };

  for (const s of summaries) {
    const existing = db.select().from(schema.emails).where(eq(schema.emails.id, s.id)).get();
    if (existing?.extractionStatus === "done" && !force) {
      out.skipped++;
      continue;
    }
    const email = (await mcp.callTool("get_email", { id: s.id })).email as RawEmail & { from: RawEmail["from"] };
    onProgress?.(`extracting ${email.id}: ${email.subject}`);

    // A fatal LLM error (bad key/model) propagates and aborts the scan; the email row stays as it was.
    const result = await extractObligations(llm, email, now);

    const row = {
      id: email.id, userId: USER_ID, source,
      fromAddr: email.from.address, subject: email.subject, receivedAt: Date.parse(email.date),
      extractionStatus: result.status,
      extractionError: result.status === "extraction_failed" ? result.error : null,
      securityFlagsJson: JSON.stringify(result.flags),
    } as const;

    db.transaction((tx) => {
      tx.insert(schema.emails).values(row).onConflictDoUpdate({ target: schema.emails.id, set: row }).run();
      tx.delete(schema.obligations).where(eq(schema.obligations.emailId, email.id)).run();
      if (result.status === "done") {
        for (const o of result.obligations) {
          tx.insert(schema.obligations).values({ ...o, userId: USER_ID }).run();
        }
      }
    });

    if (result.status === "done") {
      out.extracted++;
      out.obligations += result.obligations.length;
    } else {
      out.failed++;
      audit(db, { event: "failed", actor: "system", detail: { kind: "extraction_failed", emailId: email.id, error: result.error } });
    }
    // Provenance: remember every address this (untrusted) email introduced, so the Guard can explain taint.
    new ProvenanceStore(db, USER_ID).recordEmail(email.id, email.from.address, result.sanitizedBody, email.body);
    recordFlags(db, email.id, result.flags);
    if (result.flags.hiddenContent.length) out.hiddenContentEmails++;
    if (result.flags.injectionSuspected.length) out.injectionEmails++;
  }
  return out;
}

function recordFlags(db: Db, emailId: string, f: SecurityFlags) {
  if (f.hiddenContent.length)
    audit(db, { event: "hidden_content_detected", actor: "system", detail: { emailId, message: "hidden content detected", findings: f.hiddenContent } });
  if (f.injectionSuspected.length || f.rejectedObligations.length)
    audit(db, {
      event: "injection_suspected", actor: "system",
      detail: { emailId, injection: f.injectionSuspected, rejectedObligations: f.rejectedObligations },
    });
}

export function listObligations(db: Db) {
  return db
    .select({
      id: schema.obligations.id, emailId: schema.obligations.emailId, type: schema.obligations.type,
      title: schema.obligations.title, dueDate: schema.obligations.dueDate, amount: schema.obligations.amount,
      currency: schema.obligations.currency, counterparty: schema.obligations.counterparty,
      confidence: schema.obligations.confidence, evidenceQuote: schema.obligations.evidenceQuote,
      emailFrom: schema.emails.fromAddr, emailSubject: schema.emails.subject, emailSource: schema.emails.source,
    })
    .from(schema.obligations)
    .innerJoin(schema.emails, eq(schema.obligations.emailId, schema.emails.id))
    .orderBy(schema.obligations.dueDate)
    .all();
}

export function listEmails(db: Db) {
  const obCounts = new Map<string, number>();
  for (const o of db.select({ e: schema.obligations.emailId }).from(schema.obligations).all())
    obCounts.set(o.e, (obCounts.get(o.e) ?? 0) + 1);
  return db.select().from(schema.emails).orderBy(desc(schema.emails.receivedAt)).all().map((e) => ({
    id: e.id, from: e.fromAddr, subject: e.subject, receivedAt: e.receivedAt, source: e.source,
    status: e.extractionStatus, error: e.extractionError,
    obligationCount: obCounts.get(e.id) ?? 0,
    flags: e.securityFlagsJson ? (JSON.parse(e.securityFlagsJson) as SecurityFlags) : null,
  }));
}
