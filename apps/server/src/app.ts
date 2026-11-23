import cors from "@fastify/cors";
import Fastify from "fastify";
import type { Config } from "./config.js";
import type { Db } from "./db/index.js";
import type { McpHub } from "./mcp/hub.js";

export interface AppDeps {
  config: Config;
  db: Db;
  mcp?: McpHub;
}

export function buildApp({ config, mcp }: AppDeps) {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });
  app.register(cors, { origin: true });

  app.get("/api/health", async () => ({
    ok: true,
    service: "munshi-server",
    llmProvider: config.LLM_PROVIDER,
    llmConfigured: Boolean(config.LLM_MODEL),
    mode: "sandbox" as const,
    mcpConnected: Boolean(mcp),
  }));

  /** Debug: every MCP tool with its safety metadata (shared registry vs. what the server advertises). */
  app.get("/api/debug/mcp/tools", async (_req, reply) => {
    if (!mcp) return reply.code(503).send({ error: "MCP hub not connected" });
    const tools = await mcp.listTools();
    return {
      mode: "sandbox",
      label: "SANDBOX DATA",
      allMetadataConsistent: tools.every((t) => t.metaConsistent),
      tools,
    };
  });

  if (mcp) app.addHook("onClose", async () => mcp.close());
  return app;
}
