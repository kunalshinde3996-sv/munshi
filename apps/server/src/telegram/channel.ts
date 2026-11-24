import { and, eq, isNull } from "drizzle-orm";
import { ActionError, type ActionExecutor } from "../agent/executor.js";
import { schema, type Db } from "../db/index.js";
import { serializeAction } from "../routes.js";
import { syncNudges, unsentNudgeObligations } from "../nudges.js";
import { TelegramApi, type InlineButton, type TgUpdate } from "./api.js";

type Serialized = ReturnType<typeof serializeAction>;

export interface TelegramStatus {
  configured: boolean;
  /** TELEGRAM_CHAT_ID is set, so approvals and nudges are delivered. */
  linked: boolean;
  polling: boolean;
  bot: string | null;
  lastError: string | null;
  setup: string[];
}

export const TELEGRAM_SETUP = [
  "Open Telegram, talk to @BotFather, send /newbot, and copy the bot token.",
  "Put it in .env as TELEGRAM_BOT_TOKEN and restart the server.",
  "Open your new bot in Telegram and send /start. It replies with your chat id.",
  "Put that number in .env as TELEGRAM_CHAT_ID and restart. Approvals and nudges are then delivered there.",
];

/** Telegram text for an approval request: what will happen, who asked, and a loud provenance warning when tainted. */
export function approvalText(a: Serialized): string {
  const lines = [`Approval needed (${a.tier})${a.tainted ? " - TAINTED" : ""}`, "", a.preview ?? `${a.tool} ${JSON.stringify(a.args)}`];
  if (a.tainted) {
    lines.push("", "WARNING: a value in this action came from email content, not from you:");
    for (const t of a.taint.filter((x) => !x.trusted)) {
      const src = t.origins?.[0];
      lines.push(`- ${t.arg}: ${t.value}${src?.sender ? ` (introduced by an email from ${src.sender}${src.subject ? `, subject "${src.subject}"` : ""})` : ""}`);
    }
  }
  if (a.warnings.length) lines.push("", ...a.warnings.map((w) => `! ${w}`));
  lines.push("", `Why approval: ${a.reason}`);
  return lines.join("\n");
}

const approvalButtons = (a: Serialized): InlineButton[][] => [
  [
    { text: a.tainted ? "Approve (review warning)" : "Approve", callback_data: `a:${a.id}` },
    { text: "Reject", callback_data: `r:${a.id}` },
  ],
];

/**
 * Telegram channel. Only the configured TELEGRAM_CHAT_ID can act; every other chat can only learn its own chat id via /start.
 * Decisions go through the same ActionExecutor.approve/reject (and therefore Guard rules + audit log) as the web UI.
 * A tainted action needs a second confirming tap, enforced here and by the executor's acknowledgeTaint check.
 */
export class TelegramChannel {
  private running = false;
  private offset = 0;
  private timer: NodeJS.Timeout | null = null;
  private loop: Promise<void> | null = null;
  lastError: string | null = null;
  bot: string | null = null;

  constructor(
    private readonly db: Db,
    private readonly executor: ActionExecutor,
    private readonly api: TelegramApi,
    private readonly chatId: string | undefined,
    private readonly opts: { pollSeconds?: number; tickMs?: number; log?: (m: string) => void } = {},
  ) {}

  status(): TelegramStatus {
    return { configured: true, linked: Boolean(this.chatId), polling: this.running, bot: this.bot, lastError: this.lastError, setup: TELEGRAM_SETUP };
  }

  start() {
    if (this.running) return;
    this.running = true;
    void this.api.getMe().then((m) => (this.bot = m.username ?? null)).catch((e) => this.fail(e));
    this.loop = this.pollLoop();
    this.timer = setInterval(() => void this.tick().catch((e) => this.fail(e)), this.opts.tickMs ?? 5000);
    void this.tick().catch((e) => this.fail(e));
  }

  async stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    await Promise.race([this.loop, new Promise((r) => setTimeout(r, 100))]);
  }

  private fail(e: unknown) {
    this.lastError = e instanceof Error ? e.message : String(e);
    this.opts.log?.(`[telegram] ${this.lastError}`);
  }

  private async pollLoop() {
    while (this.running) {
      try {
        const updates = await this.api.getUpdates(this.offset, this.opts.pollSeconds ?? 25);
        this.lastError = null;
        for (const u of updates) {
          this.offset = Math.max(this.offset, u.update_id + 1);
          await this.handleUpdate(u).catch((e) => this.fail(e));
        }
      } catch (e) {
        this.fail(e);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  private isOwner(chatId: number | string | undefined) {
    return Boolean(this.chatId) && String(chatId) === String(this.chatId);
  }

  /** Process one update (exposed for tests). */
  async handleUpdate(u: TgUpdate) {
    if (u.message?.text?.startsWith("/start")) {
      const id = u.message.chat.id;
      await this.api.sendMessage(
        id,
        this.isOwner(id)
          ? "Munshi is linked to this chat. You will get approval requests and due-date nudges here."
          : `Your chat id is ${id}.\nPut TELEGRAM_CHAT_ID=${id} in Munshi's .env and restart the server to link this chat.`,
      );
      return;
    }
    const cq = u.callback_query;
    if (!cq?.data) return;
    const chat = cq.message?.chat.id;
    if (!this.isOwner(chat)) {
      await this.api.answerCallbackQuery(cq.id, "Not authorised").catch(() => {});
      return;
    }
    const verb = cq.data.slice(0, 1);
    const id = cq.data.slice(2);
    const messageId = cq.message!.message_id;
    try {
      const a = this.executor.get(id);
      if (verb === "a" && a.tainted && a.status === "pending_approval") {
        // Second-confirm step: nothing is approved by this tap.
        await this.api.editMessageText(
          chat!,
          messageId,
          `${approvalText(serializeAction(a))}\n\nThis action is TAINTED. Tap "Confirm anyway" only if you recognise this address/value and want it.`,
          [[{ text: "Confirm anyway", callback_data: `c:${id}` }, { text: "Reject", callback_data: `r:${id}` }]],
        );
        await this.api.answerCallbackQuery(cq.id, "Tap Confirm to proceed");
        return;
      }
      if (verb === "a" || verb === "c") {
        if (verb === "c" && !a.tainted) throw new ActionError("Nothing to confirm", 409);
        const done = await this.executor.approve(id, { acknowledgeTaint: verb === "c", channel: "telegram" });
        const note = done.status === "held" ? " (held for the send window; cancel it in the web app)" : "";
        await this.api.editMessageText(chat!, messageId, `${serializeAction(done).preview ?? done.tool}\n\nApproved via Telegram. Status: ${done.status}${note}`);
        await this.api.answerCallbackQuery(cq.id, "Approved");
      } else if (verb === "r") {
        const done = this.executor.reject(id, { channel: "telegram" });
        await this.api.editMessageText(chat!, messageId, `${serializeAction(done).preview ?? done.tool}\n\nRejected via Telegram.`);
        await this.api.answerCallbackQuery(cq.id, "Rejected");
      }
    } catch (e) {
      const msg = e instanceof ActionError ? e.message : "Something went wrong";
      await this.api.answerCallbackQuery(cq.id, msg).catch(() => {});
    }
  }

  /** Sends new approval requests and unsent nudges. Safe to call repeatedly (deduplicated in the notifications table). */
  async tick(now = Date.now()) {
    if (!this.chatId) return;
    const pending = this.db.select().from(schema.actions).where(eq(schema.actions.status, "pending_approval")).all();
    for (const row of pending) {
      const already = this.db.select().from(schema.notifications).where(and(eq(schema.notifications.kind, "approval"), eq(schema.notifications.refId, row.id))).get();
      if (already) continue;
      const s = serializeAction(row);
      await this.api.sendMessage(this.chatId, approvalText(s), approvalButtons(s));
      this.db.insert(schema.notifications).values({ kind: "approval", refId: row.id, telegramSentAt: now }).onConflictDoNothing().run();
    }
    syncNudges(this.db, now);
    for (const { n, o } of unsentNudgeObligations(this.db)) {
      const amt = o.amount != null ? ` (${o.currency ?? ""} ${o.amount})` : "";
      await this.api.sendMessage(
        this.chatId,
        `Due soon: ${o.title}${amt}\nDue ${o.dueDate}${o.counterparty ? ` - ${o.counterparty}` : ""}\nNot handled yet. Open Munshi and press "Handle these".`,
      );
      this.db.update(schema.notifications).set({ telegramSentAt: now }).where(and(eq(schema.notifications.id, n.id), isNull(schema.notifications.telegramSentAt))).run();
    }
  }
}
