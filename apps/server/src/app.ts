import cors from "@fastify/cors";
import Fastify from "fastify";
import type { Config } from "./config.js";
import type { Db } from "./db/index.js";

export interface AppDeps {
  config: Config;
  db: Db;
}

export function buildApp({ config }: AppDeps) {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });
  app.register(cors, { origin: true });

  app.get("/api/health", async () => ({
    ok: true,
    service: "munshi-server",
    llmProvider: config.LLM_PROVIDER,
    llmConfigured: Boolean(config.LLM_MODEL),
  }));

  return app;
}
