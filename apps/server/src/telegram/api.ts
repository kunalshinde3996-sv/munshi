/** Minimal Telegram Bot API client (plain fetch, long polling; no webhook, no SDK). The token never appears in logs or errors. */
export type FetchFn = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface TgUpdate {
  update_id: number;
  message?: { message_id: number; chat: { id: number }; text?: string };
  callback_query?: { id: string; data?: string; message?: { message_id: number; chat: { id: number } } };
}

export interface InlineButton {
  text: string;
  callback_data: string;
}

export class TelegramError extends Error {}

export class TelegramApi {
  constructor(private readonly token: string, private readonly fetchFn: FetchFn = fetch as unknown as FetchFn) {}

  private async call<T>(method: string, body: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
    let res;
    try {
      res = await this.fetchFn(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new TelegramError(`Telegram ${method} failed: ${(e as Error).name === "TimeoutError" ? "timeout" : "network error"}`);
    }
    const data = (await res.json().catch(() => null)) as { ok?: boolean; result?: T; description?: string } | null;
    if (!res.ok || !data?.ok) throw new TelegramError(`Telegram ${method} failed: HTTP ${res.status}${data?.description ? ` (${data.description})` : ""}`);
    return data.result as T;
  }

  getMe() {
    return this.call<{ username?: string }>("getMe", {});
  }
  getUpdates(offset: number, timeoutSec: number) {
    return this.call<TgUpdate[]>("getUpdates", { offset, timeout: timeoutSec, allowed_updates: ["message", "callback_query"] }, (timeoutSec + 10) * 1000);
  }
  /** Plain text on purpose (no parse_mode): previews contain email-derived text that must not be able to inject formatting. */
  sendMessage(chatId: string | number, text: string, buttons?: InlineButton[][]) {
    return this.call<{ message_id: number }>("sendMessage", {
      chat_id: chatId,
      text: text.slice(0, 3800),
      ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
    });
  }
  editMessageText(chatId: string | number, messageId: number, text: string, buttons: InlineButton[][] = []) {
    return this.call("editMessageText", { chat_id: chatId, message_id: messageId, text: text.slice(0, 3800), reply_markup: { inline_keyboard: buttons } });
  }
  answerCallbackQuery(id: string, text?: string) {
    return this.call("answerCallbackQuery", { callback_query_id: id, ...(text ? { text: text.slice(0, 190) } : {}) });
  }
}
