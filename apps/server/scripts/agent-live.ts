/**
 * Live agent check: SANDBOX DATA only, real LLM from .env for BOTH quarantined extraction and agent tool-calling.
 * scan -> "Handle these" with the default goal -> print every proposed tool call and the Guard's decision.
 * Uses an in-memory DB and a temp sandbox dir. It never approves anything, so nothing is executed except
 * calls the Guard itself allows (R1 reminders/labels); nothing external is sent.
 *   npm run agent:live
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { loadConfig } from "../src/config.js";
import { openDb, schema } from "../src/db/index.js";
import { createAgentLlm, createLlm } from "../src/llm/index.js";
import { McpHub } from "../src/mcp/hub.js";
import { ensureUser, listObligations, scanInbox } from "../src/scan.js";
import { createServices } from "../src/services.js";

const GOAL = "Set reminders for my bills and deadlines and draft follow-ups where needed"; // same default as the web UI

const config = loadConfig();
const made = createLlm(config);
const madeAgent = createAgentLlm(config);
if ("error" in made || "error" in madeAgent) {
  console.error(`Cannot run: ${"error" in made ? made.error : (madeAgent as { error: string }).error}\nSet LLM_PROVIDER, LLM_MODEL and the API key in .env.`);
  process.exit(1);
}

const { db } = openDb(":memory:");
ensureUser(db);
const mcp = new McpHub({ sandboxDir: mkdtempSync(join(tmpdir(), "munshi-agent-live-")) });
await mcp.connect();
console.log(`SANDBOX DATA | provider=${made.llm.provider} model=${made.llm.model}\n`);

let exit = 0;
try {
  console.log("1. SCAN (real extractor)");
  const summary = await scanInbox({ db, mcp, llm: made.llm, force: true, onProgress: (m) => console.log(`   ${m}`) });
  console.log(`   listed=${summary.listed} extracted=${summary.extracted} failed=${summary.failed} obligations=${summary.obligations}\n`);
  if (summary.obligations === 0) throw new Error("scan produced no obligations; nothing for the agent to handle");

  console.log(`2. HANDLE (real agent) goal: "${GOAL}"`);
  const services = createServices({ config: loadConfig({ SEND_HOLD_SECONDS: "60" }), db, mcp, agent: madeAgent.agent });
  const runtime = services.runtime!;
  const runId = runtime.start(GOAL);
  const deadline = Date.now() + 5 * 60_000;
  for (;;) {
    const st = db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, runId)).get()!.status;
    if (st !== "running") break;
    if (Date.now() > deadline) throw new Error("agent run did not finish within 5 minutes");
    await new Promise((r) => setTimeout(r, 500));
  }
  await runtime.whenIdle();

  const run = db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, runId)).get()!;
  const trace = JSON.parse(run.traceJson ?? "[]") as { kind: string; [k: string]: unknown }[];
  console.log("\nTRACE");
  for (const t of trace) console.log(`   [${t.kind}] ${String(t.text ?? t.summary ?? t.goal ?? t.tool ?? "").slice(0, 160)}`);

  const actions = db.select().from(schema.actions).where(eq(schema.actions.runId, runId)).orderBy(schema.actions.createdAt).all();
  console.log(`\nPROPOSED TOOL CALLS (${actions.length}) and Guard decisions`);
  console.table(
    actions.map((a) => {
      const g = JSON.parse(a.guardJson ?? "{}") as { rule?: string };
      return { tool: a.tool, tier: a.riskTier, decision: a.decision, tainted: a.tainted, rule: g.rule ?? "-", status: a.status, args: a.argsJson.slice(0, 70) };
    }),
  );
  console.log(`Run status: ${run.status}${run.status === "failed" ? ` (${trace.filter((t) => t.kind === "error").map((t) => t.summary).join("; ")})` : ""}`);
  console.log(`Obligations available to agent: ${listObligations(db).length}`);
  if (run.status === "failed" || actions.length === 0) exit = 1;
} catch (e) {
  console.error(`\nFAILED: ${(e as Error).message}`);
  exit = 1;
} finally {
  await mcp.close();
}
process.exit(exit);
