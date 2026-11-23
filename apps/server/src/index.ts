import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openDb } from "./db/index.js";
import { createAgentLlm, createLlm } from "./llm/index.js";
import { createServices } from "./services.js";
import { McpHub } from "./mcp/hub.js";
import { ensureUser } from "./scan.js";

const config = loadConfig();
const { db } = openDb(config.DATABASE_PATH);
ensureUser(db);
const mcp = new McpHub({ sandboxDir: config.SANDBOX_STORE_DIR });
await mcp.connect();
const made = createLlm(config);
const madeAgent = createAgentLlm(config);
const services = createServices({ config, db, mcp, ...("agent" in madeAgent ? { agent: madeAgent.agent } : { agentError: madeAgent.error }) });
services.executor.startScheduler();
services.runtime?.recover();
const app = buildApp({
  config, db, mcp, services,
  ...("llm" in made ? { llm: made.llm } : { llmError: made.error }),
});

app.listen({ port: config.PORT, host: "127.0.0.1" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void app.close().then(() => process.exit(0)));
