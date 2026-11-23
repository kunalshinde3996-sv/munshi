import { googleAuthFromEnv, googleCall } from "@munshi/mcp-common/google";
import { google, type gmail_v1 } from "googleapis";
import type { Draft, Email, EmailSummary, GmailBackend, ListOptions, Mailbox, SendInput } from "./types.js";

/** Hard limits for Google mode: last 14 days, at most 30 emails. */
export const GOOGLE_MAX_EMAILS = 30;
export const GOOGLE_WINDOW_DAYS = 14;

const b64urlDecode = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
const b64urlEncode = (s: string) => Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Header values must never contain line breaks (header injection). */
const cleanHeader = (s: string) => s.replace(/[\r\n]+/g, " ").trim();
const encodeSubject = (raw: string) => {
  const s = cleanHeader(raw);
  return /^[ -~]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
};

export function buildRawMessage(input: SendInput, from?: string): string {
  const lines = [
    ...(from ? [`From: ${cleanHeader(from)}`] : []),
    `To: ${input.to.map(cleanHeader).join(", ")}`,
    ...(input.cc.length ? [`Cc: ${input.cc.map(cleanHeader).join(", ")}`] : []),
    ...(input.bcc.length ? [`Bcc: ${input.bcc.map(cleanHeader).join(", ")}`] : []),
    `Subject: ${encodeSubject(input.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(input.body, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n"),
  ];
  return b64urlEncode(lines.join("\r\n"));
}

export function parseMailbox(raw: string): Mailbox {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(raw);
  return m ? { name: m[1]?.trim() || undefined, address: m[2]!.trim().toLowerCase() } : { address: raw.trim().toLowerCase() };
}
const addrList = (raw: string | undefined) => (raw ? raw.split(",").map((x) => parseMailbox(x).address).filter(Boolean) : []);
const header = (p: gmail_v1.Schema$MessagePart | undefined, name: string) =>
  p?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? undefined;

/**
 * Body for the (untrusted) extractor. HTML is preferred when present because that is what a human sees, and it is
 * where hidden-text attacks live; the sanitizer later strips hidden content and converts HTML to text.
 */
export function extractBody(part: gmail_v1.Schema$MessagePart | undefined): string {
  const found: { plain?: string; html?: string } = {};
  const walk = (p?: gmail_v1.Schema$MessagePart) => {
    if (!p) return;
    if (p.body?.data && p.mimeType === "text/plain") found.plain ??= b64urlDecode(p.body.data);
    if (p.body?.data && p.mimeType === "text/html") found.html ??= b64urlDecode(p.body.data);
    p.parts?.forEach(walk);
  };
  walk(part);
  return found.html ?? found.plain ?? "";
}

export class GoogleGmailBackend implements GmailBackend {
  readonly source = "google" as const;
  private labelCache: { byId: Map<string, string>; byName: Map<string, string> } | null = null;

  /** `gmail` is injectable for tests; production builds it from the env credentials. */
  constructor(private readonly gmail: gmail_v1.Gmail = google.gmail({ version: "v1", auth: googleAuthFromEnv() }), private readonly now: () => number = Date.now) {}

  private get api() {
    return this.gmail.users;
  }

  async userAddress() {
    const { data } = await googleCall(() => this.api.getProfile({ userId: "me" }));
    return (data.emailAddress ?? "").toLowerCase();
  }

  private async labels() {
    if (!this.labelCache) {
      const { data } = await googleCall(() => this.api.labels.list({ userId: "me" }));
      this.labelCache = {
        byId: new Map((data.labels ?? []).map((l) => [l.id!, l.name!])),
        byName: new Map((data.labels ?? []).map((l) => [l.name!.toLowerCase(), l.id!])),
      };
    }
    return this.labelCache;
  }

  private async labelNames(ids: string[] | null | undefined) {
    const { byId } = await this.labels();
    return (ids ?? []).map((i) => byId.get(i) ?? i);
  }

  async listRecentEmails({ limit, query, label }: ListOptions): Promise<EmailSummary[]> {
    const q = [`newer_than:${GOOGLE_WINDOW_DAYS}d`, query].filter(Boolean).join(" ");
    const labelIds = label ? [(await this.labels()).byName.get(label.toLowerCase()) ?? label] : undefined;
    const { data } = await googleCall(() =>
      this.api.messages.list({ userId: "me", q, maxResults: Math.min(limit, GOOGLE_MAX_EMAILS), labelIds }));
    const out: EmailSummary[] = [];
    for (const m of (data.messages ?? []).slice(0, GOOGLE_MAX_EMAILS)) {
      const { data: msg } = await googleCall(() =>
        this.api.messages.get({ userId: "me", id: m.id!, format: "metadata", metadataHeaders: ["From", "Subject", "Date"] }));
      out.push({
        id: msg.id!, threadId: msg.threadId ?? msg.id!, from: parseMailbox(header(msg.payload, "From") ?? ""),
        subject: header(msg.payload, "Subject") ?? "(no subject)",
        date: new Date(Number(msg.internalDate ?? this.now())).toISOString(),
        labels: await this.labelNames(msg.labelIds), snippet: msg.snippet ?? "",
      });
    }
    return out;
  }

  async getEmail(id: string): Promise<Email> {
    const { data: msg } = await googleCall(() => this.api.messages.get({ userId: "me", id, format: "full" }));
    return {
      id: msg.id!, threadId: msg.threadId ?? msg.id!, from: parseMailbox(header(msg.payload, "From") ?? ""),
      to: addrList(header(msg.payload, "To")), cc: addrList(header(msg.payload, "Cc")),
      subject: header(msg.payload, "Subject") ?? "(no subject)",
      date: new Date(Number(msg.internalDate ?? this.now())).toISOString(),
      body: extractBody(msg.payload), labels: await this.labelNames(msg.labelIds), snippet: msg.snippet ?? "",
    };
  }

  private toDraft(d: gmail_v1.Schema$Draft): Draft {
    const p = d.message?.payload;
    return {
      id: d.id!, to: addrList(header(p, "To")), cc: addrList(header(p, "Cc")), bcc: addrList(header(p, "Bcc")),
      subject: header(p, "Subject") ?? "", body: extractBody(p), createdAt: new Date(Number(d.message?.internalDate ?? this.now())).toISOString(),
    };
  }

  async createDraft(input: SendInput): Promise<Draft> {
    const { data } = await googleCall(() => this.api.drafts.create({ userId: "me", requestBody: { message: { raw: buildRawMessage(input) } } }));
    return this.getDraft(data.id!);
  }

  async getDraft(id: string): Promise<Draft> {
    const { data } = await googleCall(() => this.api.drafts.get({ userId: "me", id, format: "full" }));
    return this.toDraft(data);
  }

  async deleteDraft(id: string) {
    await googleCall(() => this.api.drafts.delete({ userId: "me", id }));
    return { deleted: true as const, id };
  }

  async sendEmail(input: SendInput): Promise<Email> {
    const { data } = await googleCall(() => this.api.messages.send({ userId: "me", requestBody: { raw: buildRawMessage(input) } }));
    return this.getEmail(data.id!);
  }

  private async modify(id: string, add: string[], remove: string[]) {
    await googleCall(() => this.api.messages.modify({ userId: "me", id, requestBody: { addLabelIds: add, removeLabelIds: remove } }));
    return this.getEmail(id);
  }

  async addLabel(id: string, label: string): Promise<Email> {
    const labels = await this.labels();
    let labelId = labels.byName.get(label.toLowerCase());
    if (!labelId) {
      const { data } = await googleCall(() => this.api.labels.create({ userId: "me", requestBody: { name: label, labelListVisibility: "labelShow", messageListVisibility: "show" } }));
      labelId = data.id!;
      labels.byName.set(label.toLowerCase(), labelId);
      labels.byId.set(labelId, label);
    }
    return this.modify(id, [labelId], []);
  }

  async removeLabel(id: string, label: string): Promise<Email> {
    const labelId = (await this.labels()).byName.get(label.toLowerCase());
    if (!labelId) throw new Error(`Label not found: ${label}`);
    return this.modify(id, [], [labelId]);
  }
}
