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
  /** JSON: hidden content found, injection phrases, rejected obligations. Never silently dropped. */
  securityFlagsJson: text("security_flags_json"),
  /** sha256 of the sanitized content the extractor saw. With `extractionModel` this is the extraction cache key. */
  contentHash: text("content_hash"),
  extractionModel: text("extraction_model"),
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
  /** Persisted agent conversation + pending step, so runs survive restarts and resume after approvals. */
  stateJson: text("state_json"),
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
  /** Full Guard result (preview, warnings, taint, checks, rule) for the approvals UI and Security view. */
  guardJson: text("guard_json"),
  verifyJson: text("verify_json"),
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
    enum: ["held", "hidden_content_detected", "injection_suspected", "proposed", "decision", "approved", "rejected", "executed", "verified",
      "verification_failed", "undone", "skipped", "failed", "policy_proposed", "policy_confirmed", "login", "login_failed", "logout"],
  }).notNull(),
  actor: text("actor").notNull(), // "agent" | "guard" | "user" | "system"
  detail: text("detail").notNull(), // JSON
});

/**
 * Provenance store: where values that could become tool arguments came from.
 * Untrusted rows are written at scan time (sender / addresses found in email content);
 * run-scoped trusted rows record addresses the user typed in their goal.
 * Trusted account address and contacts are read live from users / contacts.
 */
export const provenance = sqliteTable("provenance", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  runId: text("run_id"), // set for user_goal rows
  value: text("value").notNull(), // normalized (lowercase address)
  kind: text("kind", { enum: ["user_goal", "email_sender", "email_content"] }).notNull(),
  trusted: integer("trusted", { mode: "boolean" }).notNull(),
  emailId: text("email_id"),
  hidden: integer("hidden", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at").notNull().default(now),
});

/**
 * Outbound notifications, deduplicated per (kind, ref). `approval` rows are written when an approval request is sent to a
 * channel; `nudge` rows are created by the nudge sync (due within 48h and not handled) and delivered by channels later.
 */
export const notifications = sqliteTable(
  "notifications",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    kind: text("kind", { enum: ["approval", "nudge"] }).notNull(),
    refId: text("ref_id").notNull(),
    createdAt: integer("created_at").notNull().default(now),
    telegramSentAt: integer("telegram_sent_at"),
  },
  (t) => [uniqueIndex("notifications_kind_ref").on(t.kind, t.refId)],
);

/** Login accounts (single-user: seeded from env, no registration). Distinct from `users`, whose email is the mailbox owner's own address. */
export const authUsers = sqliteTable("auth_users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  /** scrypt$N$r$p$salt(b64)$hash(b64) */
  passwordHash: text("password_hash").notNull(),
  userId: text("user_id").notNull().references(() => users.id),
  createdAt: integer("created_at").notNull().default(now),
});

/** Server-side sessions. Only sha256(token) is stored; the raw token lives in the httpOnly cookie. */
export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  authUserId: text("auth_user_id").notNull().references(() => authUsers.id),
  createdAt: integer("created_at").notNull().default(now),
  expiresAt: integer("expires_at").notNull(),
});
