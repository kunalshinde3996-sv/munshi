import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openDb } from "./db/index.js";
import { McpHub } from "./mcp/hub.js";

const config = loadConfig();
const { db } = openDb(config.DATABASE_PATH);
const mcp = new McpHub({ sandboxDir: config.SANDBOX_STORE_DIR });
await mcp.connect();
const app = buildApp({ config, db, mcp });

app.listen({ port: config.PORT, host: "127.0.0.1" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void app.close().then(() => process.exit(0)));
