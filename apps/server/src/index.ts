import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openDb } from "./db/index.js";

const config = loadConfig();
const { db } = openDb(config.DATABASE_PATH);
const app = buildApp({ config, db });

app.listen({ port: config.PORT, host: "127.0.0.1" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
