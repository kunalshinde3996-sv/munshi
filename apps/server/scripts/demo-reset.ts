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
console.log(config.SANDBOX_ATTACK_EMAILS ? "  attack emails  20 injection + 10 benign look-alike emails will be seeded (SANDBOX DATA)" : "  attack emails  disabled (SANDBOX_ATTACK_EMAILS=false)");
console.log("Next: npm run dev:server  &&  npm run dev:web");
