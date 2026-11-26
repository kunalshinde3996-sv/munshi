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
  const nav = (label) => page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: new RegExp(`^${label}`) }).click();
  const sub = (label) => page.getByRole("navigation", { name: "Trust sections" }).getByRole("button", { name: label, exact: true }).click();
  const top = () => page.evaluate(() => window.scrollTo(0, 0));

  // 01 login (demo bar + demo-account button + form)
  await page.goto(BASE);
  await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
  await page.locator("text=DEMO MODE").first().waitFor();
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

  // 03 Today after a scan, before Munshi acts
  await page.getByRole("heading", { name: "Ready when you are." }).waitFor();
  await page.getByRole("button", { name: "Scan inbox" }).click();
  await page.getByText("Checked 15 emails.").waitFor({ timeout: 60_000 });
  await page.getByText("BESCOM electricity bill").first().waitFor();
  await page.getByRole("button", { name: "Let Munshi handle it" }).waitFor();
  await top();
  await snap("03-today-after-scan");

  // 04 Today brief: what needs you
  await page.getByRole("button", { name: "Let Munshi handle it" }).click();
  await page.getByRole("heading", { name: /things need you\./ }).waitFor({ timeout: 60_000 });
  await page.getByText("This address came from the email, not from you.").waitFor();
  await page.getByText("5 reminders added").waitFor(); // the run has finished proposing; nothing is still in flight
  await top();
  await snap("04-today-brief");

  // 05 "Why?" drawer: full provenance for the tainted draft
  await page.getByRole("button", { name: "Why?" }).click();
  await page.getByRole("dialog").getByText("Where each address came from").waitFor();
  await snap("05-why-drawer");
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });

  // 06 obligation drawer: evidence quote and source email
  await page.getByRole("region", { name: "Coming up" }).getByRole("button", { name: /BESCOM electricity bill/ }).click();
  await page.getByRole("dialog").getByText("The line this came from").waitFor();
  await snap("06-evidence-drawer");
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });

  // 07 Handled, expanded, with Done and Undo
  const handled = page.getByTestId("handled");
  await handled.locator("summary").click();
  await handled.getByText("Done ✓").first().waitFor();
  await handled.getByRole("button", { name: /^Undo/ }).first().waitFor();
  await handled.evaluate((el) => { el.scrollIntoView({ block: "start" }); window.scrollBy(0, -40); });
  await snap("07-today-handled");

  // 12 the same brief on a 375px phone (captured now, while approvals are pending)
  await page.setViewportSize({ width: 375, height: 812 });
  await handled.locator("summary").click();
  await top();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 0) throw new Error(`Today overflows a 375px screen by ${overflow}px`);
  await snap("12-today-mobile");
  await page.setViewportSize({ width: 1440, height: 900 });

  // 08 Trust: security
  await nav("Trust");
  await page.getByRole("heading", { name: /Blocked and tainted actions \(1\)/ }).waitFor();
  await page.getByRole("heading", { name: /Suspicious emails \([1-9]/ }).waitFor();
  await top();
  await snap("08-trust-security");

  // 09 Trust: activity with verify and undo
  await sub("Activity");
  await page.getByText("Verified").first().waitFor();
  await page.getByRole("button", { name: /^Undo$/ }).first().waitFor();
  await snap("09-trust-activity");

  // 10 Trust: eval
  await sub("Eval");
  await page.getByRole("heading", { name: "Attack evaluation" }).waitFor();
  await snap("10-trust-eval");

  // 11 Settings
  await nav("Settings");
  await page.getByRole("heading", { name: "Policies" }).waitFor();
  await page.getByText("Email is never sent without your approval.").waitFor();
  await top();
  await snap("11-settings");

  await browser.close();
  browser = undefined;
  const bad = shots.filter(([, size]) => size < 10_000); // the calm screens are mostly flat colour, so their PNGs are small
  if (bad.length) throw new Error(`suspiciously small screenshots: ${bad.map((b) => b[0]).join(", ")}`);
  console.log(`\nDone: ${shots.length} screenshots in docs/screenshots/`);
} catch (e) {
  console.error(`\nFAILED: ${e.message}`);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
  stopAll();
}
