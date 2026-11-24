import { dirname, resolve } from "node:path";
import { buildApp } from "./app.js";
import { installCrashHandlers } from "./crash-log.js";
import { loadConfig } from "./config.js";
import { openDb } from "./db/index.js";
import { createAgentLlm, createLlm } from "./llm/index.js";
import { createServices } from "./services.js";
import { busyReason, GoogleConnection } from "./google/connection.js";
import { McpHub } from "./mcp/hub.js";
import { ensureUser } from "./scan.js";
import { ScanScheduler } from "./scheduler.js";

const config = loadConfig();
// Log (console + data/server-error.log) instead of dying silently on stray rejections/exceptions.
const ERROR_LOG = resolve(dirname(resolve(config.DATABASE_PATH)), "server-error.log");
installCrashHandlers(ERROR_LOG);
const { db } = openDb(config.DATABASE_PATH);
ensureUser(db);
// Saved per-user mode decides which backend the MCP servers start with.
const mcp = new McpHub({ sandboxDir: config.SANDBOX_STORE_DIR });
const google = new GoogleConnection(config, db, mcp, GoogleConnection.providerFor(config), () => busyReason(db));
await mcp.reconnect(google.startupHubOptions());
mcp.onAuthProblem = (m) => { google.authProblem = m; };
const made = createLlm(config);
const madeAgent = createAgentLlm(config);
const services = createServices({ config, db, mcp, ...("agent" in madeAgent ? { agent: madeAgent.agent } : { agentError: madeAgent.error }) });
services.executor.startScheduler();
services.runtime?.recover();
services.telegram?.start();
const scheduler = "llm" in made && process.env.NODE_ENV !== "test"
  ? new ScanScheduler({ db, mcp, llm: made.llm, intervalMin: config.SCAN_INTERVAL_MIN, log: (m) => console.log(m) })
  : undefined;
scheduler?.start();
const app = buildApp({
  config, db, mcp, services, google, scheduler,
  ...("llm" in made ? { llm: made.llm } : { llmError: made.error }),
});

app.listen({ port: config.PORT, host: "127.0.0.1" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void app.close().then(() => process.exit(0)));
