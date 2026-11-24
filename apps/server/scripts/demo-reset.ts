/**
 * Reset to a clean demo state: deletes the app database and the SANDBOX DATA store, then recreates
 * the schema and default policies. Stop the server first (it holds the files open).
 *   npm run demo:reset
 */
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { ensureUser } from "../src/scan.js";

const config = loadConfig();
const dbPath = resolve(config.DATABASE_PATH);
const sandbox = resolve(config.SANDBOX_STORE_DIR);

try {
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) rmSync(f, { force: true });
  rmSync(sandbox, { recursive: true, force: true });
} catch (e) {
  console.error(`Could not delete demo files (is the server still running?): ${(e as Error).message}`);
  process.exit(1);
}

const { db, sqlite } = openDb(dbPath);
ensureUser(db); // sandbox mode + default policies
sqlite.close();

console.log("Demo state reset:");
console.log(`  database       ${dbPath}  (fresh schema, sandbox mode, default policies)`);
console.log(`  SANDBOX DATA   ${sandbox}  (mailbox/calendar will be re-seeded on first use, dates relative to today)`);
console.log(config.SANDBOX_ATTACK_EMAILS ? "  mailbox        15 demo emails + 30 eval emails (SANDBOX_ATTACK_EMAILS=true) - SANDBOX DATA" : "  mailbox        15 demo emails (9 legit, 4 noise, 2 injection) - SANDBOX DATA. The 30 eval emails stay in fixtures/attacks for eval:attacks.");
console.log("Next: npm run dev:server  &&  npm run dev:web");
