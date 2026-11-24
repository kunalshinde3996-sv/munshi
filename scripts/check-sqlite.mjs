// Verifies the native SQLite binding loads (run after `npm install`): npm run check:sqlite
import { createRequire } from "node:module";
const require = createRequire(new URL("../apps/server/package.json", import.meta.url));
try {
  const Database = require("better-sqlite3");
  const db = new Database(":memory:");
  db.exec("create table t(x)");
  db.prepare("insert into t values (?)").run(42);
  const row = db.prepare("select x from t").get();
  if (row.x !== 42) throw new Error("unexpected query result");
  console.log(`better-sqlite3 OK (node ${process.version}, ${process.platform}/${process.arch})`);
} catch (e) {
  console.error(`better-sqlite3 failed to load: ${e.message}\nSee README > "If better-sqlite3 fails to load".`);
  process.exit(1);
}
