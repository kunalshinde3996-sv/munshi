import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openDb, schema } from "../src/db/index.js";
import { McpHub } from "../src/mcp/hub.js";
import { listNudges, syncNudges } from "../src/nudges.js";
import { ensureUser, scanInbox } from "../src/scan.js";
import { createServices } from "../src/services.js";
import type { FetchFn } from "../src/telegram/api.js";
import { MockAgent, MockLlm, obligationJson, obligationsFrom, withSession } from "./helpers.js";

let dir: string;
let hub: McpHub;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "munshi-tg-"));
  hub = new McpHub({ sandboxDir: dir });
  await hub.connect();
}, 60_000);
afterAll(async () => {
  await hub.close();
  rmSync(dir, { recursive: true, force: true });
});

function fakeTelegram() {
  const calls: { method: string; body: any }[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    const method = url.split("/").pop()!;
    calls.push({ method, body: JSON.parse(init?.body ?? "{}") });
    return { ok: true, status: 200, json: async () => ({ ok: true, result: method === "sendMessage" ? { message_id: calls.length } : method === "getMe" ? { username: "munshi_bot" } : [] }) };
  };
  return { fetchFn, calls, sent: () => calls.filter((c) => c.method === "sendMessage").map((c) => c.body) };
}

async function setup() {
  const { db } = openDb(":memory:");
  const extractor = new MockLlm((req) => {
    if (req.user.includes("Refund amount: Rs 2,499.00"))
      return obligationJson({ type: "refund", title: "Amazon refund pending", dueDate: "2030-01-06", amount: 2499, currency: "INR", confidence: 0.7, evidenceQuote: "Refund amount: Rs 2,499.00" });
    return JSON.stringify({ obligations: [] });
  });
  await scanInbox({ db, mcp: hub, llm: extractor });
  const tg = fakeTelegram();
  const agent = new MockAgent((messages, call) => {
    if (call > 1) return { text: "done" };
    const amazon = obligationsFrom(messages).find((o) => o.title.includes("Amazon"))!;
    return {
      toolCalls: [
        // confidence 0.7 < 0.8 -> needs approval, not tainted
        { name: "create_event", args: { title: "Amazon refund due", start: "2030-01-06T09:00:00+05:30", obligationId: amazon.id } },
        // address introduced by an email -> tainted approval
        { name: "create_draft", args: { to: [amazon.senderAddress], subject: "Refund status", body: "Where is my refund?", obligationId: amazon.id } },
      ],
    };
  });
  const services = createServices({
    config: { SEND_HOLD_SECONDS: 60, TELEGRAM_BOT_TOKEN: "TOKEN123", TELEGRAM_CHAT_ID: "42" },
    db, mcp: hub, agent, telegramFetch: tg.fetchFn,
  });
  services.runtime!.start("Handle my refund and follow up");
  await services.runtime!.whenIdle();
  return { db, tg, services, channel: services.telegram! };
}

const cb = (data: string, chat = 42) => ({ update_id: 1, callback_query: { id: "cbq", data, message: { message_id: 7, chat: { id: chat } } } });

describe("Telegram channel", () => {
  it("sends approval requests (preview + provenance warning + buttons) exactly once", async () => {
    const { tg, channel, db } = await setup();
    await channel.tick();
    const msgs = tg.sent();
    expect(msgs).toHaveLength(2);
    const draft = msgs.find((m) => m.text.includes("DRAFT"))!;
    expect(draft.text).toContain("TAINTED");
    expect(draft.text).toContain("came from email content");
    expect(draft.reply_markup.inline_keyboard[0].map((b: any) => b.text.split(" ")[0])).toEqual(["Approve", "Reject"]);
    expect(msgs.every((m) => m.chat_id === "42")).toBe(true);
    await channel.tick();
    expect(tg.sent()).toHaveLength(2); // deduplicated
    expect(db.select().from(schema.notifications).where(eq(schema.notifications.kind, "approval")).all()).toHaveLength(2);
    // the bot token is never part of any request body
    expect(JSON.stringify(tg.calls)).not.toContain("TOKEN123");
  });

  it("approve/reject go through the executor + audit log; ignores other chats; tainted needs a second tap", async () => {
    const { db, tg, services, channel } = await setup();
    await channel.tick();
    const rows = db.select().from(schema.actions).all();
    const plain = rows.find((a) => a.tool === "create_event" && a.status === "pending_approval")!;
    const tainted = rows.find((a) => a.tool === "create_draft")!;
    expect(tainted.tainted).toBe(true);

    // a stranger's tap does nothing
    await channel.handleUpdate(cb(`a:${plain.id}`, 999));
    expect(services.executor.get(plain.id).status).toBe("pending_approval");
    expect(tg.calls.at(-1)!.body.text).toBe("Not authorised");

    // untainted: one tap approves, executes and verifies
    await channel.handleUpdate(cb(`a:${plain.id}`));
    expect(["executed", "verified"]).toContain(services.executor.get(plain.id).status);
    const audited = db.select().from(schema.auditLog).where(eq(schema.auditLog.actionId, plain.id)).all();
    expect(audited.find((e) => e.event === "approved")!.detail).toContain('"channel":"telegram"');

    // tainted: first tap only asks for confirmation (nothing approved, no execution)
    await channel.handleUpdate(cb(`a:${tainted.id}`));
    expect(services.executor.get(tainted.id).status).toBe("pending_approval");
    const edit = tg.calls.filter((c) => c.method === "editMessageText").at(-1)!.body;
    expect(edit.text).toContain("TAINTED");
    expect(edit.reply_markup.inline_keyboard[0][0].callback_data).toBe(`c:${tainted.id}`);
    // confirming a NON-tainted action via the confirm verb is refused
    await channel.handleUpdate(cb(`c:${plain.id}`));
    expect(tg.calls.at(-1)!.body.text).toBe("Nothing to confirm");
    // second tap approves
    await channel.handleUpdate(cb(`c:${tainted.id}`));
    expect(["executed", "verified"]).toContain(services.executor.get(tainted.id).status);
    const approved = db.select().from(schema.auditLog).where(eq(schema.auditLog.actionId, tainted.id)).all().find((e) => e.event === "approved")!;
    expect(approved.detail).toContain('"acknowledgedTaint":true');

    // already-settled action cannot be decided again
    await channel.handleUpdate(cb(`r:${plain.id}`));
    expect(tg.calls.at(-1)!.body.text).toContain("not pending approval");
  });

  it("reject via Telegram is audited; /start tells an unlinked chat its id", async () => {
    const { db, tg, services, channel } = await setup();
    await channel.tick();
    const a = db.select().from(schema.actions).all().find((x) => x.status === "pending_approval")!;
    await channel.handleUpdate(cb(`r:${a.id}`));
    expect(services.executor.get(a.id).status).toBe("rejected");
    await channel.handleUpdate({ update_id: 2, message: { message_id: 1, chat: { id: 555 }, text: "/start" } });
    const last = tg.sent().at(-1)!;
    expect(last.chat_id).toBe(555);
    expect(last.text).toContain("TELEGRAM_CHAT_ID=555");
  });

  it("nudges: due within 48h and unhandled are created once, sent once, and disappear when handled", async () => {
    const { db, tg, channel } = await setup();
    const soon = new Date(Date.now() + 20 * 3600_000).toISOString().slice(0, 10);
    const o = db.select().from(schema.obligations).all()[0]!;
    db.update(schema.obligations).set({ dueDate: soon }).where(eq(schema.obligations.id, o.id)).run();
    // the setup run already has actions for this obligation (pending approvals count as "being handled")
    expect(syncNudges(db)).toHaveLength(0);
    db.delete(schema.notifications).run();
    db.update(schema.actions).set({ status: "rejected" }).run();
    const created = syncNudges(db);
    expect(created.map((c) => c.id)).toEqual([o.id]);
    expect(syncNudges(db)).toHaveLength(0); // once
    await channel.tick();
    const nudgeMsgs = tg.sent().filter((m) => m.text.startsWith("Due soon"));
    expect(nudgeMsgs).toHaveLength(1);
    await channel.tick();
    expect(tg.sent().filter((m) => m.text.startsWith("Due soon"))).toHaveLength(1);
    expect(listNudges(db).map((n) => n.obligationId)).toEqual([o.id]);
    db.update(schema.actions).set({ status: "verified" }).run(); // now handled
    expect(listNudges(db)).toHaveLength(0);
  });

  it("without a token: Not configured, and nothing else breaks", async () => {
    const { db } = openDb(":memory:");
    ensureUser(db);
    const services = createServices({ config: { SEND_HOLD_SECONDS: 60 }, db, mcp: hub });
    expect(services.telegram).toBeUndefined();
    const app = withSession(buildApp({ config: loadConfig({}), db, mcp: hub, services }), db);
    const res = (await app.inject({ method: "GET", url: "/api/telegram" })).json();
    expect(res).toMatchObject({ configured: false, linked: false });
    expect(res.setup.length).toBeGreaterThan(2);
    expect((await app.inject({ method: "GET", url: "/api/nudges" })).json()).toEqual({ nudges: [] });
    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
  });
});
