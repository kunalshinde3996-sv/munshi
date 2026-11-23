import { sql } from "drizzle-orm";
import { integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const now = sql`(unixepoch() * 1000)`;

/** Single-user prototype, but everything is keyed by user so it can grow. */
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull(), // the user's own address (TRUSTED provenance)
  mode: text("mode", { enum: ["sandbox", "google"] }).notNull().default("sandbox"),
  createdAt: integer("created_at").notNull().default(now),
});

/** OAuth tokens, AES-256-GCM encrypted at rest (ciphertext is base64 iv.tag.data). */
export const oauthTokens = sqliteTable("oauth_tokens", {
  userId: text("user_id").primaryKey().references(() => users.id),
  provider: text("provider").notNull().default("google"),
  encrypted: text("encrypted").notNull(),
  updatedAt: integer("updated_at").notNull().default(now),
});

export const emails = sqliteTable("emails", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  source: text("source", { enum: ["sandbox", "google"] }).notNull(),
  fromAddr: text("from_addr").notNull(),
  subject: text("subject").notNull(),
  receivedAt: integer("received_at").notNull(),
  extractionStatus: text("extraction_status", {
    enum: ["pending", "done", "extraction_failed"],
  }).notNull().default("pending"),
  extractionError: text("extraction_error"),
});

export const obligations = sqliteTable("obligations", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  emailId: text("email_id").notNull().references(() => emails.id),
  type: text("type", {
    enum: ["bill", "deadline", "renewal", "refund", "appointment", "travel", "other"],
  }).notNull(),
  title: text("title").notNull(),
  dueDate: text("due_date"),
  amount: real("amount"),
  currency: text("currency"),
  counterparty: text("counterparty"),
  confidence: real("confidence").notNull(),
  evidenceQuote: text("evidence_quote").notNull(),
  createdAt: integer("created_at").notNull().default(now),
});

export const contacts = sqliteTable(
  "contacts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    name: text("name").notNull(),
    email: text("email").notNull(), // stored lowercase
  },
  (t) => [uniqueIndex("contacts_user_email").on(t.userId, t.email)],
);

export const policies = sqliteTable("policies", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  ruleJson: text("rule_json").notNull(), // zod-validated policy rule
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at").notNull().default(now),
});

export const agentRuns = sqliteTable("agent_runs", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  goal: text("goal").notNull(),
  status: text("status", {
    enum: ["running", "awaiting_approval", "completed", "failed"],
  }).notNull(),
  traceJson: text("trace_json").notNull().default("[]"), // full trace for the UI
  startedAt: integer("started_at").notNull().default(now),
  finishedAt: integer("finished_at"),
});

/** One row per tool call the agent proposed. Also the idempotency ledger. */
export const actions = sqliteTable("actions", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => agentRuns.id),
  obligationId: text("obligation_id"),
  tool: text("tool").notNull(),
  argsJson: text("args_json").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  riskTier: text("risk_tier", { enum: ["R0", "R1", "R2", "R3"] }).notNull(),
  tainted: integer("tainted", { mode: "boolean" }).notNull().default(false),
  decision: text("decision", { enum: ["allow", "require_approval", "block", "skipped"] }).notNull(),
  decisionReason: text("decision_reason").notNull(),
  status: text("status", {
    enum: ["pending_approval", "approved", "rejected", "blocked", "held", "executed",
      "verified", "verification_failed", "undone", "skipped", "failed"],
  }).notNull(),
  resultJson: text("result_json"),
  holdUntil: integer("hold_until"),
  createdAt: integer("created_at").notNull().default(now),
});

/** Append-only. Application code must only ever INSERT into this table. */
export const auditLog = sqliteTable("audit_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ts: integer("ts").notNull().default(now),
  runId: text("run_id"),
  actionId: text("action_id"),
  event: text("event", {
    enum: ["proposed", "decision", "approved", "rejected", "executed", "verified",
      "verification_failed", "undone", "skipped", "failed"],
  }).notNull(),
  actor: text("actor").notNull(), // "agent" | "guard" | "user" | "system"
  detail: text("detail").notNull(), // JSON
});
