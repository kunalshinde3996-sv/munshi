import cors from "@fastify/cors";
import Fastify from "fastify";
import { z } from "zod";
import type { Config } from "./config.js";
import type { Db } from "./db/index.js";
import { schema } from "./db/index.js";
import { sanitizeEmailBody } from "./extraction/sanitize.js";
import { LlmError, type LlmAdapter } from "./llm/types.js";
import { GoogleAuthToolError, type McpHub } from "./mcp/hub.js";
import { registerAgentRoutes } from "./routes.js";
import { registerGoogleRoutes } from "./routes-google.js";
import type { GoogleConnection } from "./google/connection.js";
import type { Services } from "./services.js";
import type { ScanScheduler } from "./scheduler.js";
import { currentMode, listEmails, listObligations, scanInbox } from "./scan.js";
import { eq } from "drizzle-orm";
import { audit } from "./audit.js";
import { compilePolicy, PolicyCompileError, PolicyDrafts } from "./guard/policy-compile.js";
import { USER_ID } from "./scan.js";

export interface AppDeps {
  config: Config;
  db: Db;
  mcp?: McpHub;
  /** Undefined when not configured; `llmError` then explains why. */
  llm?: LlmAdapter;
  llmError?: string;
  services?: Services;
  google?: GoogleConnection;
  /** Background scanner (absent in tests and when SCAN_INTERVAL_MIN=0). */
  scheduler?: ScanScheduler;
}

/** Mode comes from the database (per-user setting), never hardcoded. Sandbox data is always labelled. */
const modeInfo = (db: Db) => {
  const mode = currentMode(db);
  return { mode, label: mode === "sandbox" ? "SANDBOX DATA" : null } as const;
};

export function buildApp({ config, db, mcp, llm, llmError, services, google, scheduler }: AppDeps) {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });
  // Local single-user app: only the Munshi web UI may call the API from a browser. This blocks other websites
  // (CSRF, e.g. a page that POSTs /api/actions/:id/approve) and DNS-rebinding attempts.
  const allowedOrigins = new Set([config.WEB_ORIGIN, `http://localhost:${config.PORT}`, `http://127.0.0.1:${config.PORT}`, "http://127.0.0.1:5173"]);
  app.register(cors, { origin: [...allowedOrigins] });
  app.addHook("onRequest", async (req, reply) => {
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (host && !["localhost", "127.0.0.1", "[::1]"].includes(host)) return reply.code(403).send({ error: "Forbidden host" });
    const origin = req.headers.origin;
    if (req.method !== "GET" && req.method !== "OPTIONS" && origin && !allowedOrigins.has(origin)) {
      return reply.code(403).send({ error: "Cross-origin request blocked" });
    }
  });

  app.get("/api/health", async () => ({
    ok: true,
    service: "munshi-server",
    llmProvider: config.LLM_PROVIDER,
    llmConfigured: Boolean(llm),
    llmModel: llm?.model ?? null,
    agentAvailable: Boolean(services?.runtime),
    agentError: services?.runtime ? null : (services?.agentError ?? "Agent not configured"),
    holdSeconds: config.SEND_HOLD_SECONDS,
    llmError: llm ? null : (llmError ?? "LLM not configured"),
    mode: currentMode(db),
    googleAuthProblem: google?.authProblem ?? null,
    mcpConnected: Boolean(mcp),
  }));

  /** Debug: every MCP tool with its safety metadata (shared registry vs. what the server advertises). */
  app.get("/api/debug/mcp/tools", async (_req, reply) => {
    if (!mcp) return reply.code(503).send({ error: "MCP hub not connected" });
    const tools = await mcp.listTools();
    return { ...modeInfo(db), allMetadataConsistent: tools.every((t) => t.metaConsistent), tools };
  });

  /** Scan the inbox: quarantined extraction of every email not yet extracted (or all, with force). */
  app.post("/api/scan", async (req, reply) => {
    if (!mcp) return reply.code(503).send({ error: "MCP hub not connected" });
    if (!llm) return reply.code(503).send({ error: `LLM not configured: ${llmError ?? "unknown"}` });
    const { force } = z.object({ force: z.boolean().optional() }).parse(req.body ?? {});
    try {
      const summary = await scanInbox({ db, mcp, llm, force });
      return { ...modeInfo(db), summary };
    } catch (e) {
      if (e instanceof LlmError) return reply.code(502).send({ error: `LLM error: ${e.message}` });
      if (e instanceof GoogleAuthToolError) return reply.code(401).send({ code: "google_auth", error: e.message });
      throw e;
    }
  });

  app.get("/api/scheduler", async () =>
    scheduler?.status() ?? { enabled: false, intervalMin: config.SCAN_INTERVAL_MIN, running: false, lastRunAt: null, lastSummary: null, lastError: null, newNudges: 0, nextRunAt: null },
  );

  app.get("/api/obligations", async () => ({ ...modeInfo(db), obligations: listObligations(db) }));

  app.get("/api/emails", async () => ({ ...modeInfo(db), emails: listEmails(db) }));

  /** One email for the "source email" view: raw (user's own mail), what the extractor saw, and flags. */
  app.get("/api/emails/:id", async (req, reply) => {
    if (!mcp) return reply.code(503).send({ error: "MCP hub not connected" });
    const { id } = z.object({ id: z.string() }).parse(req.params);
    let email;
    try {
      email = (await mcp.callTool("get_email", { id })).email;
    } catch (e) {
      if (e instanceof GoogleAuthToolError) return reply.code(401).send({ code: "google_auth", error: e.message });
      return reply.code(404).send({ error: "Email not found" });
    }
    const row = db.select().from(schema.emails).where(eq(schema.emails.id, id)).get();
    return {
      ...modeInfo(db),
      email,
      extractorInput: sanitizeEmailBody(email.body).text,
      status: row?.extractionStatus ?? "pending",
      error: row?.extractionError ?? null,
      flags: row?.securityFlagsJson ? JSON.parse(row.securityFlagsJson) : null,
    };
  });

  // ---- plain-language policies: compile -> user reviews -> explicit confirm. The LLM never activates a rule. ----
  const drafts = new PolicyDrafts();
  app.post("/api/policies/compile", async (req, reply) => {
    if (!llm) return reply.code(503).send({ error: `LLM not configured: ${llmError ?? "unknown"}` });
    const { text } = z.object({ text: z.string().trim().min(5).max(500) }).parse(req.body);
    try {
      const compiled = await compilePolicy(llm, text);
      const d = drafts.add(compiled, text);
      audit(db, { event: "policy_proposed", actor: "system", detail: { draftId: d.id, text, rule: compiled.rule } });
      return { draftId: d.id, expiresAt: d.expiresAt, rule: compiled.rule, readback: compiled.readback, warnings: compiled.warnings };
    } catch (e) {
      if (e instanceof PolicyCompileError) return reply.code(422).send({ error: e.message });
      if (e instanceof LlmError) return reply.code(502).send({ error: `LLM error: ${e.message}` });
      throw e;
    }
  });
  app.post("/api/policies/compile/:draftId/confirm", async (req, reply) => {
    const { draftId } = z.object({ draftId: z.string() }).parse(req.params);
    const d = drafts.take(draftId);
    if (!d) return reply.code(404).send({ error: "That draft expired or was already used. Compile it again." });
    const rule = d.policy.rule;
    db.insert(schema.policies).values({ id: rule.id, userId: USER_ID, ruleJson: JSON.stringify(rule) }).run();
    audit(db, { event: "policy_confirmed", actor: "user", detail: { draftId, text: d.text, rule } });
    return { policy: { id: rule.id, enabled: true, seed: false, rule, valid: true } };
  });
  app.delete("/api/policies/compile/:draftId", async (req) => {
    const { draftId } = z.object({ draftId: z.string() }).parse(req.params);
    return { ok: drafts.discard(draftId) };
  });

  registerAgentRoutes(app, db, services);
  registerGoogleRoutes(app, config, google);

  if (services) app.addHook("onClose", async () => { services.executor.stopScheduler(); await services.telegram?.stop(); await services.runtime?.whenIdle(); });
  if (scheduler) app.addHook("onClose", async () => scheduler.stop());
  if (mcp) app.addHook("onClose", async () => mcp.close());
  return app;
}
