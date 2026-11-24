import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openDb, schema } from "../src/db/index.js";
import { LlmError } from "../src/llm/types.js";
import { McpHub } from "../src/mcp/hub.js";
import { listNudges } from "../src/nudges.js";
import { scanInbox } from "../src/scan.js";
import { ScanScheduler } from "../src/scheduler.js";
import { MockLlm, obligationJson } from "./helpers.js";

let dir: string;
let hub: McpHub;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "munshi-sched-"));
  hub = new McpHub({ sandboxDir: dir });
  await hub.connect();
}, 60_000);
afterAll(async () => {
  await hub.close();
  rmSync(dir, { recursive: true, force: true });
});

const dueSoon = () => new Date(Date.now() + 20 * 3600_000).toISOString().slice(0, 16) + "Z";
const extractor = () =>
  new MockLlm((req) =>
    req.user.includes("Amount payable: Rs 1,847.00")
      ? obligationJson({ type: "bill", title: "BESCOM electricity bill", dueDate: dueSoon(), amount: 1847, currency: "INR", evidenceQuote: "Amount payable: Rs 1,847.00" })
      : JSON.stringify({ obligations: [] }),
  );

describe("proactive scan scheduler", () => {
  it("a pass scans, creates nudges, uses the cache next time, and never creates runs or actions", async () => {
    const { db } = openDb(":memory:");
    const llm = extractor();
    const s = new ScanScheduler({ db, mcp: hub, llm, intervalMin: 30 });
    await s.runOnce();
    expect(s.status()).toMatchObject({ enabled: true, lastError: null, newNudges: 1, lastSummary: { listed: 15, extracted: 15 } });
    expect(listNudges(db).map((n) => n.title)).toEqual(["BESCOM electricity bill"]);
    // nothing was executed or even proposed: no agent run, no action, no R2 send
    expect(db.select().from(schema.agentRuns).all()).toHaveLength(0);
    expect(db.select().from(schema.actions).all()).toHaveLength(0);
    expect((await hub.callTool("list_recent_emails", { label: "SENT", limit: 50 })).emails).toHaveLength(0);

    const calls = llm.calls.length;
    await s.runOnce();
    expect(llm.calls.length).toBe(calls); // fully cached
    expect(s.status()).toMatchObject({ newNudges: 0, lastSummary: { skipped: 15, extracted: 0 } });
  }, 60_000);

  it("is off when the interval is 0, skips overlapping passes, and reports errors (e.g. all models over quota)", async () => {
    const { db } = openDb(":memory:");
    const off = new ScanScheduler({ db, mcp: hub, llm: extractor(), intervalMin: 0 });
    off.start();
    expect(off.status()).toMatchObject({ enabled: false, nextRunAt: null });

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = new MockLlm(async () => {
      await gate;
      return JSON.stringify({ obligations: [] });
    });
    const s = new ScanScheduler({ db, mcp: hub, llm: slow, intervalMin: 5 });
    const first = s.runOnce();
    await new Promise((r) => setTimeout(r, 50));
    expect(s.status().running).toBe(true);
    await s.runOnce(); // overlapping pass returns immediately
    expect(slow.calls.length).toBe(1);
    release();
    await first;
    expect(s.status().running).toBe(false);

    const { db: db2 } = openDb(":memory:");
    const quota = new MockLlm(() => {
      throw new LlmError("All configured LLM models are over quota until about 1:00 PM", true, 429, false, true);
    });
    const bad = new ScanScheduler({ db: db2, mcp: hub, llm: quota, intervalMin: 5 });
    await bad.runOnce();
    expect(bad.status().lastError).toContain("over quota");
    expect(bad.status().running).toBe(false);
  }, 60_000);

  it("scans on the same database are serialized (scheduled + manual never overlap)", async () => {
    const { db } = openDb(":memory:");
    let active = 0;
    let maxActive = 0;
    const llm = new MockLlm(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 2));
      active--;
      return JSON.stringify({ obligations: [] });
    });
    await Promise.all([scanInbox({ db, mcp: hub, llm }), scanInbox({ db, mcp: hub, llm })]);
    expect(maxActive).toBe(1);
  }, 60_000);

  it("GET /api/scheduler reports status (no scheduler is built in tests)", async () => {
    const { db } = openDb(":memory:");
    const off = buildApp({ config: loadConfig({}), db, mcp: hub });
    expect((await off.inject({ method: "GET", url: "/api/scheduler" })).json()).toMatchObject({ enabled: false, running: false, lastRunAt: null });
    const sched = new ScanScheduler({ db, mcp: hub, llm: extractor(), intervalMin: 0 });
    const on = buildApp({ config: loadConfig({ SCAN_INTERVAL_MIN: "0" }), db, mcp: hub, scheduler: sched });
    expect((await on.inject({ method: "GET", url: "/api/scheduler" })).json()).toMatchObject({ enabled: false });
  });
});
