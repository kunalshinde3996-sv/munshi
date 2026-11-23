import cors from "@fastify/cors";
import Fastify from "fastify";
import { z } from "zod";
import type { Config } from "./config.js";
import type { Db } from "./db/index.js";
import { schema } from "./db/index.js";
import { sanitizeEmailBody } from "./extraction/sanitize.js";
import { LlmError, type LlmAdapter } from "./llm/types.js";
import type { McpHub } from "./mcp/hub.js";
import { registerAgentRoutes } from "./routes.js";
import type { Services } from "./services.js";
import { listEmails, listObligations, scanInbox } from "./scan.js";
import { eq } from "drizzle-orm";

export interface AppDeps {
  config: Config;
  db: Db;
  mcp?: McpHub;
  /** Undefined when not configured; `llmError` then explains why. */
  llm?: LlmAdapter;
  llmError?: string;
  services?: Services;
}

const MODE = { mode: "sandbox", label: "SANDBOX DATA" } as const;

export function buildApp({ config, db, mcp, llm, llmError, services }: AppDeps) {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });
  app.register(cors, { origin: true });

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
    mode: MODE.mode,
    mcpConnected: Boolean(mcp),
  }));

  /** Debug: every MCP tool with its safety metadata (shared registry vs. what the server advertises). */
  app.get("/api/debug/mcp/tools", async (_req, reply) => {
    if (!mcp) return reply.code(503).send({ error: "MCP hub not connected" });
    const tools = await mcp.listTools();
    return { ...MODE, allMetadataConsistent: tools.every((t) => t.metaConsistent), tools };
  });

  /** Scan the inbox: quarantined extraction of every email not yet extracted (or all, with force). */
  app.post("/api/scan", async (req, reply) => {
    if (!mcp) return reply.code(503).send({ error: "MCP hub not connected" });
    if (!llm) return reply.code(503).send({ error: `LLM not configured: ${llmError ?? "unknown"}` });
    const { force } = z.object({ force: z.boolean().optional() }).parse(req.body ?? {});
    try {
      const summary = await scanInbox({ db, mcp, llm, force });
      return { ...MODE, summary };
    } catch (e) {
      if (e instanceof LlmError) return reply.code(502).send({ error: `LLM error: ${e.message}` });
      throw e;
    }
  });

  app.get("/api/obligations", async () => ({ ...MODE, obligations: listObligations(db) }));

  app.get("/api/emails", async () => ({ ...MODE, emails: listEmails(db) }));

  /** One email for the "source email" view: raw (user's own mail), what the extractor saw, and flags. */
  app.get("/api/emails/:id", async (req, reply) => {
    if (!mcp) return reply.code(503).send({ error: "MCP hub not connected" });
    const { id } = z.object({ id: z.string() }).parse(req.params);
    let email;
    try {
      email = (await mcp.callTool("get_email", { id })).email;
    } catch {
      return reply.code(404).send({ error: "Email not found" });
    }
    const row = db.select().from(schema.emails).where(eq(schema.emails.id, id)).get();
    return {
      ...MODE,
      email,
      extractorInput: sanitizeEmailBody(email.body).text,
      status: row?.extractionStatus ?? "pending",
      error: row?.extractionError ?? null,
      flags: row?.securityFlagsJson ? JSON.parse(row.securityFlagsJson) : null,
    };
  });

  registerAgentRoutes(app, db, services);

  if (services) app.addHook("onClose", async () => { services.executor.stopScheduler(); await services.runtime?.whenIdle(); });
  if (mcp) app.addHook("onClose", async () => mcp.close());
  return app;
}
