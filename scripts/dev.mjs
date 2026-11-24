// npm run dev: starts the API (:8787) and the web UI (:5173) together. Ctrl+C stops both.
import { spawn, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const win = process.platform === "win32";
const procs = ["dev:server", "dev:web"].map((s) => spawn("npm", ["run", s], { cwd: root, shell: true, stdio: "inherit", detached: !win }));
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  for (const p of procs) {
    try { if (win) spawnSync("taskkill", ["/pid", String(p.pid), "/T", "/F"], { stdio: "ignore" }); else process.kill(-p.pid, "SIGTERM"); } catch { /* already gone */ }
  }
};
process.on("SIGINT", () => { stop(); process.exit(0); });
process.on("SIGTERM", () => { stop(); process.exit(0); });
process.on("exit", stop);
for (const p of procs) p.on("exit", (code) => { if (!stopping && code) { console.error(`A dev process exited with code ${code}; stopping.`); stop(); process.exit(code); } });
