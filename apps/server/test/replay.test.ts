import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { createAgentLlm, createLlm } from "../src/llm/index.js";
import { REPLAY_BANNER } from "../src/llm/replay.js";
import { McpHub } from "../src/mcp/hub.js";
import { ensureUser } from "../src/scan.js";
import { createServices } from "../src/services.js";

let dir: string;
let hub: McpHub;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "munshi-replay-"));
  hub = new McpHub({ sandboxDir: dir });
  await hub.connect();
}, 60_000);
afterAll(async () => {
  await hub.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("LLM_PROVIDER=replay (no API key)", () => {
  it("builds both adapters without a key or model, and health carries the banner", async () => {
    const config = loadConfig({ LLM_PROVIDER: "replay", SANDBOX_ATTACK_EMAILS: "false" });
    const llm = createLlm(config);
    const agent = createAgentLlm(config);
    expect("llm" in llm && "agent" in agent).toBe(true);
    const { db } = openDb(":memory:");
    ensureUser(db);
    const app = buildApp({ config, db, mcp: hub, llm: (llm as { llm: never }).llm, services: createServices({ config, db, mcp: hub, agent: (agent as { agent: never }).agent }) });
    const h = (await app.inject({ method: "GET", url: "/api/health" })).json();
    expect(h.replay).toBe(true);
    expect(h.replayBanner).toBe(REPLAY_BANNER);
    expect(h.llmConfigured).toBe(true);
  });

  it("scan -> handle -> Guard decisions, through the normal pipeline", async () => {
    const config = loadConfig({ LLM_PROVIDER: "replay", SANDBOX_ATTACK_EMAILS: "false", SEND_HOLD_SECONDS: "60" });
    const { db } = openDb(":memory:");
    ensureUser(db);
    const llm = (createLlm(config) as { llm: never }).llm;
    const agent = (createAgentLlm(config) as { agent: never }).agent;
    const services = createServices({ config, db, mcp: hub, agent });
    const app = buildApp({ config, db, mcp: hub, llm, services });
    const get = async (url: string) => (await app.inject({ method: "GET", url })).json();

    const scan = (await app.inject({ method: "POST", url: "/api/scan", payload: {} })).json();
    expect(scan.summary.failed).toBe(0);
    expect(scan.summary.obligations).toBe(9);
    // recorded obligations carry real, future dates
    const obs = (await get("/api/obligations")).obligations as { dueDate: string; title: string }[];
    expect(obs.every((o) => !o.dueDate || new Date(o.dueDate).getTime() > Date.now() - 86_400_000)).toBe(true);

    const { runId } = (await app.inject({ method: "POST", url: "/api/runs", payload: { goal: "Set reminders for my bills and deadlines and draft follow-ups where needed" } })).json();
    await services.runtime!.whenIdle();
    const run = await get(`/api/runs/${runId}`);
    const tools = (run.actions as { tool: string }[]).map((a) => a.tool);
    expect(tools.filter((t) => t === "create_event")).toHaveLength(6);
    expect(tools.filter((t) => t === "create_draft")).toHaveLength(1);
    expect(tools).not.toContain("send_email");
    // low-confidence refund reminder and the tainted draft to the sender need approval; high-confidence reminders run
    const states = run.actions as { decision: string; tool: string; status: string }[];
    expect(states.some((a) => a.decision === "require_approval")).toBe(true);
    expect(states.some((a) => a.status === "verified")).toBe(true);
    expect(["awaiting_approval", "finished", "completed"]).toContain(run.run.status);
  });
});
