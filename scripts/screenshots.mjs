// Automated README screenshots: npm run screenshots
// demo:reset -> start server + web -> sign in -> walk the demo flow -> 1440x900 PNGs in docs/screenshots/ -> stop servers.
// Everything captured is SANDBOX DATA in demo mode (scripted sample outputs); no API key is needed.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { chromium } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, "docs/screenshots");
mkdirSync(outDir, { recursive: true });
const win = process.platform === "win32";

function env() {
  const out = {};
  const p = resolve(root, ".env");
  if (existsSync(p)) for (const l of readFileSync(p, "utf8").split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m) out[m[1]] = m[2]; }
  return { ...out, ...process.env };
}
const E = env();
if (E.LLM_PROVIDER !== "replay") { console.error("Screenshots are captured in demo mode: set LLM_PROVIDER=replay in .env."); process.exit(1); }
if (!E.DEMO_USER_EMAIL || !E.DEMO_USER_PASSWORD) { console.error("Set DEMO_USER_EMAIL and DEMO_USER_PASSWORD in .env."); process.exit(1); }

const inUse = (port) => new Promise((res) => { const s = net.createConnection({ port, host: "127.0.0.1" }); s.on("connect", () => { s.destroy(); res(true); }); s.on("error", () => res(false)); });
for (const port of [8787, 5173]) if (await inUse(port)) { console.error(`Port ${port} is in use. Stop the dev servers first.`); process.exit(1); }

console.log("demo:reset");
const reset = spawnSync("npm", ["run", "demo:reset"], { cwd: root, shell: true, stdio: "inherit" });
if (reset.status !== 0) process.exit(1);

const procs = [];
const start = (script) => { const p = spawn("npm", ["run", script], { cwd: root, shell: true, stdio: "ignore", detached: !win }); procs.push(p); };
const stopAll = () => {
  for (const p of procs) {
    try { if (win) spawnSync("taskkill", ["/pid", String(p.pid), "/T", "/F"], { stdio: "ignore" }); else process.kill(-p.pid, "SIGTERM"); } catch { /* already gone */ }
  }
};
process.on("exit", stopAll);
const waitFor = async (url, what) => {
  for (let i = 0; i < 90; i++) { try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 1000)); }
  throw new Error(`${what} did not start`);
};

const shots = [];
let browser;
try {
  start("dev:server");
  start("dev:web");
  await waitFor("http://localhost:8787/api/health", "server");
  await waitFor("http://localhost:5173/", "web");

  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const BASE = "http://localhost:5173/";
  const snap = async (name) => {
    await page.waitForTimeout(500);
    const file = resolve(outDir, `${name}.png`);
    await page.screenshot({ path: file });
    shots.push([name, statSync(file).size]);
    console.log(`  captured ${name}`);
  };
  const tab = (label) => page.locator("nav button", { hasText: new RegExp(`^${label}`) }).click();

  // 01 login (demo banner + form + demo-account button)
  await page.goto(BASE);
  await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
  await page.locator('text=DEMO MODE').first().waitFor();
  await page.getByRole("button", { name: "Use demo account" }).waitFor();
  await snap("01-login");

  // real login with the .env credentials (the demo-account button is covered by tests)
  await page.getByLabel("Email").fill(E.DEMO_USER_EMAIL);
  await page.getByLabel("Password").fill(E.DEMO_USER_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  // 02 onboarding
  await page.getByRole("button", { name: "Try sandbox" }).waitFor();
  await snap("02-onboarding");
  await page.getByRole("button", { name: "Try sandbox" }).click();

  // 03 inbox after scan
  await page.getByRole("heading", { name: "Your inbox, as obligations" }).waitFor();
  await page.getByRole("button", { name: "Scan inbox" }).click();
  await page.getByText(/Scanned 15 emails/).waitFor({ timeout: 60_000 });
  await page.getByText("BESCOM electricity bill").first().waitFor();
  await page.evaluate(() => window.scrollTo(0, 0));
  await snap("03-inbox-obligations");

  // 04 security notes on the inbox
  const notes = page.getByRole("heading", { name: /Security notes/ });
  await notes.waitFor();
  await notes.scrollIntoViewIfNeeded();
  await page.evaluate(() => { const h = [...document.querySelectorAll("h2")].find((x) => /Security notes/.test(x.textContent || "")); h?.scrollIntoView({ block: "start" }); window.scrollBy(0, -80); });
  await snap("04-security-notes");

  // 05 run timeline
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.getByRole("button", { name: "Handle these" }).click();
  await page.getByText(/need your approval/).waitFor({ timeout: 60_000 });
  await page.evaluate(() => { const h = [...document.querySelectorAll("h2")].find((x) => /Handle these/.test(x.textContent || "")); h?.scrollIntoView({ block: "start" }); window.scrollBy(0, -80); });
  await snap("05-run-timeline");

  // 06 approvals: tainted draft card in view
  await tab("Approvals");
  await page.getByText("Where is my refund?").first().waitFor();
  await page.evaluate(() => { const a = [...document.querySelectorAll("article")].find((x) => /Not from you/.test(x.textContent || "")); a?.scrollIntoView({ block: "center" }); });
  await snap("06-approvals");

  // 07 activity: verified actions with Undo
  await tab("Activity");
  await page.getByText("Verified").first().waitFor();
  await page.getByRole("button", { name: /Undo/ }).first().waitFor();
  await snap("07-activity");

  // 08 security tab
  await tab("Security");
  await page.getByRole("heading", { name: /Blocked and tainted actions/ }).waitFor();
  await snap("08-security-tab");

  // 09 policies
  await tab("Policies");
  await page.getByRole("heading", { name: "Policies" }).waitFor();
  await snap("09-policies");

  // 10 eval
  await tab("Eval");
  await page.getByRole("heading", { name: "Attack evaluation" }).waitFor();
  await snap("10-eval");

  await browser.close();
  browser = undefined;
  const bad = shots.filter(([, size]) => size < 20_000);
  if (bad.length) throw new Error(`suspiciously small screenshots: ${bad.map((b) => b[0]).join(", ")}`);
  console.log(`\nDone: ${shots.length} screenshots in docs/screenshots/`);
} catch (e) {
  console.error(`\nFAILED: ${e.message}`);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
  stopAll();
}
