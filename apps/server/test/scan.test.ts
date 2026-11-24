import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openDb, schema } from "../src/db/index.js";
import { McpHub } from "../src/mcp/hub.js";
import { scanInbox } from "../src/scan.js";
import { MockLlm, obligationJson, withSession } from "./helpers.js";

let dir: string;
let hub: McpHub;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "munshi-scan-"));
  hub = new McpHub({ sandboxDir: dir });
  await hub.connect();
}, 60_000);
afterAll(async () => {
  await hub.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Scripted extractor: grounded answers for two emails, garbage for one, empty for the rest. */
function scriptedLlm(state: { breakAct: boolean }) {
  return new MockLlm((req) => {
    if (req.user.includes("Amount payable: Rs 1,847.00"))
      return obligationJson({
        type: "bill", title: "BESCOM electricity bill", dueDate: "2030-01-05", amount: 1847, currency: "INR",
        counterparty: "BESCOM", evidenceQuote: "Amount payable: Rs 1,847.00",
      });
    if (req.user.includes("Time: 4:30 PM IST"))
      return obligationJson({ type: "appointment", title: "Dentist appointment", dueDate: "2030-01-07T16:30:00+05:30", evidenceQuote: "Time: 4:30 PM IST" });
    if (state.breakAct && req.user.includes("ACT Fibernet invoice")) return "I cannot comply";
    return JSON.stringify({ obligations: [] });
  });
}

describe("scan + obligations API (sandbox, mock LLM)", () => {
  it("scans, persists obligations, surfaces failures and security flags, and is idempotent", async () => {
    const { db } = openDb(":memory:");
    const state = { breakAct: true };
    const llm = scriptedLlm(state);
    const app = withSession(buildApp({ config: loadConfig({}), db, mcp: hub, llm }), db);

    const scan = await app.inject({ method: "POST", url: "/api/scan", payload: {} });
    expect(scan.statusCode).toBe(200);
    expect(scan.json().label).toBe("SANDBOX DATA");
    expect(scan.json().summary).toMatchObject({
      listed: 15, extracted: 14, failed: 1, obligations: 2, hiddenContentEmails: 1,
    });
    expect(scan.json().summary.injectionEmails).toBe(2);

    const obs = (await app.inject({ method: "GET", url: "/api/obligations" })).json();
    expect(obs.obligations.map((o: { title: string }) => o.title).sort()).toEqual(["BESCOM electricity bill", "Dentist appointment"]);
    expect(obs.obligations[0]).toHaveProperty("emailSubject");

    const emails = (await app.inject({ method: "GET", url: "/api/emails" })).json().emails as any[];
    expect(emails).toHaveLength(15);
    const act = emails.find((e) => e.id === "sbx-act");
    expect(act).toMatchObject({ status: "extraction_failed" });
    expect(act.error).toBeTruthy(); // stored visibly, not dropped
    expect(emails.find((e) => e.id === "sbx-inject-news").flags.hiddenContent).toHaveLength(1);
    expect(emails.find((e) => e.id === "sbx-inject-bank").flags.injectionSuspected.length).toBeGreaterThan(0);

    // audit trail
    const events = db.select().from(schema.auditLog).all();
    expect(events.some((e) => e.event === "hidden_content_detected" && e.detail.includes("hidden content detected"))).toBe(true);
    expect(events.some((e) => e.event === "injection_suspected")).toBe(true);
    expect(events.some((e) => e.event === "failed" && e.detail.includes("sbx-act"))).toBe(true);

    // rescan: done emails skipped, failed one retried (now succeeds)
    state.breakAct = false;
    const callsBefore = llm.calls.length;
    const again = (await app.inject({ method: "POST", url: "/api/scan", payload: {} })).json().summary;
    expect(again).toMatchObject({ skipped: 14, extracted: 1, failed: 0 });
    expect(llm.calls.length - callsBefore).toBe(1);
    expect((await app.inject({ method: "GET", url: "/api/obligations" })).json().obligations).toHaveLength(2);
  }, 60_000);

  it("extraction cache: skips unchanged email+model, re-extracts on model change, changed content, or force", async () => {
    const { db } = openDb(":memory:");
    const llm = scriptedLlm({ breakAct: false });
    const run = (l: MockLlm, force = false) => scanInbox({ db, mcp: hub, llm: l, force });
    expect(await run(llm)).toMatchObject({ extracted: 15, skipped: 0 });
    const calls = llm.calls.length;
    expect(await run(llm)).toMatchObject({ extracted: 0, skipped: 15 });
    expect(llm.calls.length).toBe(calls); // fully served from cache: zero LLM calls

    const other = scriptedLlm({ breakAct: false });
    (other as { model: string }).model = "another-model";
    expect(await run(other)).toMatchObject({ extracted: 15, skipped: 0 }); // model is part of the key
    expect(await run(other, true)).toMatchObject({ extracted: 15, skipped: 0 }); // "Re-scan all"

    db.update(schema.emails).set({ contentHash: "stale" }).where(eq(schema.emails.id, "sbx-bescom")).run();
    expect(await run(other)).toMatchObject({ extracted: 1, skipped: 14 }); // content changed -> only that one
  }, 60_000);

  it("GET /api/emails/:id shows the extractor input with hidden text removed", async () => {
    const { db } = openDb(":memory:");
    const app = withSession(buildApp({ config: loadConfig({}), db, mcp: hub, llm: scriptedLlm({ breakAct: false }) }), db);
    await app.inject({ method: "POST", url: "/api/scan", payload: {} });
    const res = (await app.inject({ method: "GET", url: "/api/emails/sbx-inject-news" })).json();
    expect(res.email.body).toContain("claim-prize"); // user's own raw mail
    expect(res.extractorInput).not.toContain("claim-prize");
    expect(res.flags.hiddenContent[0].kind).toBe("display_none");
    expect((await app.inject({ method: "GET", url: "/api/emails/nope" })).statusCode).toBe(404);
  }, 60_000);

  it("POST /api/scan returns 503 with the reason when no LLM is configured", async () => {
    const { db } = openDb(":memory:");
    const app = withSession(buildApp({ config: loadConfig({}), db, mcp: hub, llmError: "LLM_MODEL is not set in .env" }), db);
    const res = await app.inject({ method: "POST", url: "/api/scan", payload: {} });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toContain("LLM_MODEL");
    const health = (await app.inject({ method: "GET", url: "/api/health" })).json();
    expect(health).toMatchObject({ llmConfigured: false, llmError: "LLM_MODEL is not set in .env" });
  });
});
