import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { GoogleAuthError, mapGoogleError } from "@munshi/mcp-common/google";
import { GoogleGmailBackend, buildRawMessage, extractBody, parseMailbox } from "@munshi/mcp-gmail/google";
import { GoogleCalendarBackend } from "@munshi/mcp-calendar/google";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openDb, schema } from "../src/db/index.js";
import { decryptJson, encryptJson } from "../src/google/crypto.js";
import { GoogleConnection, REQUIRED_SCOPES, type OAuthProvider } from "../src/google/connection.js";
import { GoogleAuthToolError } from "../src/mcp/hub.js";
import { ensureUser, scanInbox } from "../src/scan.js";
import { MockLlm, withSession } from "./helpers.js";

const KEY = Buffer.alloc(32, 7).toString("base64");
const b64u = (s: string) => Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

describe("token encryption (AES-256-GCM)", () => {
  it("round-trips, uses a fresh IV, and never stores plaintext", () => {
    const a = encryptJson({ refreshToken: "1//secret" }, KEY);
    const b = encryptJson({ refreshToken: "1//secret" }, KEY);
    expect(a).not.toBe(b);
    expect(a).not.toContain("secret");
    expect(a.startsWith("v1.")).toBe(true);
    expect(decryptJson(a, KEY)).toEqual({ refreshToken: "1//secret" });
  });
  it("rejects tampering, a wrong key, and bad keys", () => {
    const enc = encryptJson({ x: 1 }, KEY);
    const parts = enc.split(".");
    const flipped = Buffer.from(parts[3]!, "base64");
    flipped[0] = flipped[0]! ^ 1;
    expect(() => decryptJson([parts[0], parts[1], parts[2], flipped.toString("base64")].join("."), KEY)).toThrow();
    expect(() => decryptJson(enc, Buffer.alloc(32, 9).toString("base64"))).toThrow();
    expect(() => encryptJson({}, "short")).toThrow(/32 bytes/);
    expect(() => encryptJson({}, undefined)).toThrow(/not set/);
  });
});

function fakeProvider(overrides: Partial<{ refreshToken: string | undefined; scopes: string[] }> = {}) {
  const revoked: string[] = [];
  const provider: OAuthProvider = {
    authUrl: (state) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}&scope=${encodeURIComponent(REQUIRED_SCOPES.join(" "))}`,
    exchange: async () => ({ refreshToken: "refreshToken" in overrides ? overrides.refreshToken : "1//refresh-xyz", email: "real.user@gmail.com", scopes: overrides.scopes ?? [...REQUIRED_SCOPES] }),
    revoke: async (t) => void revoked.push(t),
  };
  return { provider, revoked };
}
const CFG = { GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "csecret", GOOGLE_REDIRECT_URI: "http://localhost:8787/auth/google/callback", TOKEN_ENCRYPTION_KEY: KEY, WEB_ORIGIN: "http://localhost:5173", SANDBOX_STORE_DIR: "./x" };

function conn(opts: { cfg?: Partial<typeof CFG>; provider?: OAuthProvider; busy?: () => string | null } = {}) {
  const { db } = openDb(":memory:");
  ensureUser(db);
  const reconnects: unknown[] = [];
  const c = new GoogleConnection({ ...CFG, ...opts.cfg } as never, db, { reconnect: async (o) => void reconnects.push(o) }, opts.provider, opts.busy);
  return { db, c, reconnects };
}
const connect = async (c: GoogleConnection) => {
  const url = new URL(c.startUrl());
  await c.handleCallback("auth-code", url.searchParams.get("state")!);
};

describe("Google connection: OAuth, encrypted tokens, mode", () => {
  it("is 'Not configured' with setup steps naming the missing env vars (sandbox keeps working)", () => {
    const { c } = conn({ cfg: { GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined, TOKEN_ENCRYPTION_KEY: undefined } });
    const s = c.status();
    expect(s).toMatchObject({ configured: false, connected: false, mode: "sandbox" });
    expect(s.missing).toEqual(["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "TOKEN_ENCRYPTION_KEY"]);
    expect(s.setupSteps.join("\n")).toContain("http://localhost:8787/auth/google/callback");
    expect(() => c.startUrl()).toThrow(/not configured/);
  });

  it("completes OAuth, stores only encrypted tokens, and validates state/scopes/refresh token", async () => {
    const { provider } = fakeProvider();
    const { c, db } = conn({ provider });
    await connect(c);
    const raw = db.select().from(schema.oauthTokens).get()!.encrypted;
    expect(raw).not.toContain("refresh-xyz");
    expect(decryptJson<{ refreshToken: string; email: string }>(raw, KEY)).toMatchObject({ refreshToken: "1//refresh-xyz", email: "real.user@gmail.com" });
    expect(c.status()).toMatchObject({ connected: true, email: "real.user@gmail.com" });

    await expect(c.handleCallback("code", "forged-state")).rejects.toThrow(/Invalid or expired OAuth state/);
    const url = new URL(c.startUrl());
    const st = url.searchParams.get("state")!;
    await c.handleCallback("code", st);
    await expect(c.handleCallback("code", st)).rejects.toThrow(/state/); // single use

    const noRefresh = conn({ provider: fakeProvider({ refreshToken: undefined }).provider });
    await expect(connect(noRefresh.c)).rejects.toThrow(/refresh token/);
    const fewScopes = conn({ provider: fakeProvider({ scopes: [REQUIRED_SCOPES[0]!] }).provider });
    await expect(connect(fewScopes.c)).rejects.toThrow(/missing: gmail.compose/);
  });

  it("a wrong encryption key or tampered row reads as 'not connected' rather than leaking or crashing", async () => {
    const { c, db } = conn({ provider: fakeProvider().provider });
    await connect(c);
    const other = new GoogleConnection({ ...CFG, TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64") } as never, db, { reconnect: async () => undefined }, fakeProvider().provider);
    expect(other.status().connected).toBe(false);
  });

  it("switches mode per user: reconnects MCP with Google credentials, and the trusted own-address follows", async () => {
    const { c, db, reconnects } = conn({ provider: fakeProvider().provider });
    await expect(c.setMode("google")).rejects.toThrow(/Connect Google first/);
    await connect(c);
    await c.setMode("google");
    expect(c.getMode()).toBe("google");
    expect(reconnects.at(-1)).toMatchObject({ backend: "google", env: { GOOGLE_REFRESH_TOKEN: "1//refresh-xyz", GOOGLE_CLIENT_ID: "cid" } });
    expect(db.select().from(schema.users).where(eq(schema.users.id, "local")).get()!.email).toBe("real.user@gmail.com");
    await c.setMode("sandbox");
    expect(reconnects.at(-1)).toMatchObject({ backend: "sandbox" });
    expect(db.select().from(schema.users).where(eq(schema.users.id, "local")).get()!.email).toBe("rohan.mehta@example.com");
  });

  it("refuses to switch while work is in flight", async () => {
    const { c } = conn({ provider: fakeProvider().provider, busy: () => "agent run run-1 is awaiting approval" });
    await connect(c);
    await expect(c.setMode("google")).rejects.toThrow(/in progress: agent run run-1/);
  });

  it("disconnect revokes, deletes tokens and returns to sandbox", async () => {
    const f = fakeProvider();
    const { c, db } = conn({ provider: f.provider });
    await connect(c);
    await c.setMode("google");
    await c.disconnect();
    expect(f.revoked).toEqual(["1//refresh-xyz"]);
    expect(db.select().from(schema.oauthTokens).all()).toHaveLength(0);
    expect(c.status()).toMatchObject({ connected: false, mode: "sandbox" });
  });

  it("startup falls back to sandbox if the saved mode is google but Google is unusable", () => {
    const { c, db } = conn({ provider: fakeProvider().provider });
    db.update(schema.users).set({ mode: "google" }).run();
    expect(c.startupHubOptions().backend).toBe("sandbox");
    expect(c.getMode()).toBe("sandbox");
  });
});

describe("Google HTTP routes + honest mode reporting", () => {
  it("status / start / callback / mode endpoints; health.mode reflects the database", async () => {
    const { provider } = fakeProvider();
    const { c, db } = conn({ provider });
    const app = withSession(buildApp({ config: loadConfig({}), db, google: c }), db);

    expect((await app.inject({ method: "GET", url: "/api/health" })).json()).toMatchObject({ mode: "sandbox" });
    const start = await app.inject({ method: "GET", url: "/auth/google/start" });
    expect(start.statusCode).toBe(302);
    const loc = new URL(start.headers.location as string);
    expect(loc.host).toBe("accounts.google.com");

    const cb = await app.inject({ method: "GET", url: `/auth/google/callback?code=abc&state=${loc.searchParams.get("state")}` });
    expect(cb.headers.location).toBe("http://localhost:5173/?google=connected");
    const bad = await app.inject({ method: "GET", url: "/auth/google/callback?code=abc&state=nope" });
    expect(String(bad.headers.location)).toContain("google=error");
    expect(String(bad.headers.location)).toContain("Invalid");

    expect((await app.inject({ method: "GET", url: "/api/google/status" })).json()).toMatchObject({ configured: true, connected: true });
    const sw = await app.inject({ method: "POST", url: "/api/settings/mode", payload: { mode: "google" } });
    expect(sw.statusCode).toBe(200);
    const h = (await app.inject({ method: "GET", url: "/api/health" })).json();
    expect(h.mode).toBe("google");
    expect((await app.inject({ method: "GET", url: "/api/obligations" })).json().label).toBeNull(); // no SANDBOX label on real data
    expect((await app.inject({ method: "POST", url: "/api/settings/mode", payload: { mode: "sandbox" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/obligations" })).json().label).toBe("SANDBOX DATA");
  });

  it("unconfigured: start returns a clear 400 and switching to google is refused", async () => {
    const { c, db } = conn({ cfg: { GOOGLE_CLIENT_ID: undefined } });
    const app = withSession(buildApp({ config: loadConfig({}), db, google: c }), db);
    const s = await app.inject({ method: "GET", url: "/auth/google/start" });
    expect(s.statusCode).toBe(400);
    expect(s.json().error).toContain("GOOGLE_CLIENT_ID");
    expect((await app.inject({ method: "POST", url: "/api/settings/mode", payload: { mode: "google" } })).statusCode).toBe(400);
  });

  it("a revoked Google grant during a scan surfaces as 401 google_auth", async () => {
    const { c, db } = conn({ provider: fakeProvider().provider });
    const mcp = { callTool: async () => { throw new GoogleAuthToolError("Google access was revoked or has expired. Reconnect Google in Munshi."); }, close: async () => undefined } as never;
    const app = withSession(buildApp({ config: loadConfig({}), db, mcp, llm: new MockLlm(() => "{}"), google: c }), db);
    const res = await app.inject({ method: "POST", url: "/api/scan", payload: {} });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: "google_auth" });
    expect(res.json().error).toMatch(/Reconnect/);
    void scanInbox;
  });
});

// ---- backends against fake Google clients ----

const hdr = (name: string, value: string) => ({ name, value });
function gmailFake(opts: { messages?: number } = {}) {
  const calls: Record<string, any[]> = { list: [], send: [], draftCreate: [], modify: [], labelCreate: [] };
  const labels = [{ id: "INBOX", name: "INBOX" }, { id: "SENT", name: "SENT" }, { id: "Label_1", name: "Bills" }];
  const store: Record<string, any> = {
    m1: { id: "m1", threadId: "t1", internalDate: "1700000000000", snippet: "snip", labelIds: ["INBOX", "Label_1"], payload: { headers: [hdr("From", "BESCOM <Billing@Bescom.example>"), hdr("To", "me@example.com, Other <o@example.com>"), hdr("Cc", "c@example.com"), hdr("Subject", "Bill")], mimeType: "multipart/alternative", parts: [{ mimeType: "text/plain", body: { data: b64u("plain text") } }, { mimeType: "text/html", body: { data: b64u("<p>html text</p><span style=\"display:none\">hidden</span>") } }] } },
  };
  const api = {
    users: {
      getProfile: async () => ({ data: { emailAddress: "Real.User@Gmail.com" } }),
      labels: {
        list: async () => ({ data: { labels } }),
        create: async (a: any) => { calls.labelCreate!.push(a); const l = { id: "Label_9", name: a.requestBody.name }; labels.push(l); return { data: l }; },
      },
      messages: {
        list: async (a: any) => { calls.list!.push(a); return { data: { messages: Array.from({ length: opts.messages ?? 1 }, () => ({ id: "m1" })) } }; },
        get: async (a: any) => ({ data: store[a.id] ?? store.m1 }),
        send: async (a: any) => { calls.send!.push(a); store.sent1 = { id: "sent1", threadId: "ts", internalDate: "1700000001000", labelIds: ["SENT"], payload: { headers: [hdr("To", "a@example.com"), hdr("Subject", "Hi")], body: { data: "" } } }; return { data: { id: "sent1" } }; },
        modify: async (a: any) => { calls.modify!.push(a); const m = store[a.id] ?? store.m1; m.labelIds = [...new Set([...(m.labelIds ?? []).filter((l: string) => !(a.requestBody.removeLabelIds ?? []).includes(l)), ...(a.requestBody.addLabelIds ?? [])])]; return { data: {} }; },
      },
      drafts: {
        create: async (a: any) => { calls.draftCreate!.push(a); const raw = unb64u(a.requestBody.message.raw); store.d1 = { id: "d1", raw }; return { data: { id: "d1" } }; },
        get: async () => ({ data: { id: "d1", message: { internalDate: "1700000000000", payload: { headers: [hdr("To", "a@example.com"), hdr("Subject", "Hi")], mimeType: "text/plain", body: { data: b64u("body") } } } } }),
        delete: async () => ({ data: {} }),
      },
    },
  };
  return { api: api as never, calls, store };
}

describe("GoogleGmailBackend (fake Gmail API)", () => {
  it("lists only the last 14 days, capped at 30 emails, and maps messages", async () => {
    const f = gmailFake({ messages: 40 });
    const b = new GoogleGmailBackend(f.api);
    const out = await b.listRecentEmails({ limit: 50, query: "bill" });
    expect(f.calls.list![0]).toMatchObject({ maxResults: 30, q: "newer_than:14d bill" });
    expect(out).toHaveLength(30);
    expect(out[0]).toMatchObject({ id: "m1", from: { name: "BESCOM", address: "billing@bescom.example" }, subject: "Bill", labels: ["INBOX", "Bills"], snippet: "snip" });
  });

  it("getEmail prefers the HTML part (where hidden-text attacks live) and parses recipients", async () => {
    const e = await new GoogleGmailBackend(gmailFake().api).getEmail("m1");
    expect(e.body).toContain("display:none");
    expect(e.to).toEqual(["me@example.com", "o@example.com"]);
    expect(e.cc).toEqual(["c@example.com"]);
    expect(extractBody({ mimeType: "text/plain", body: { data: b64u("only plain") } })).toBe("only plain");
    expect(parseMailbox("plain@x.com")).toEqual({ address: "plain@x.com" });
  });

  it("builds RFC 822 safely: no header injection, UTF-8 subjects encoded, base64 body", async () => {
    const raw = unb64u(buildRawMessage({ to: ["a@example.com"], cc: [], bcc: ["b@example.com"], subject: "Hi\r\nBcc: evil@attacker.example", body: "Hello ₹" }));
    const headers = raw.split("\r\n\r\n")[0]!.split("\r\n");
    expect(headers.filter((h) => h.startsWith("Bcc:"))).toEqual(["Bcc: b@example.com"]); // injected Bcc did not become a header
    expect(headers.find((h) => h.startsWith("Subject:"))).toBe("Subject: Hi Bcc: evil@attacker.example");
    expect(unb64u(buildRawMessage({ to: ["a@example.com"], cc: [], bcc: [], subject: "रिफंड", body: "x" }))).toMatch(/Subject: =\?UTF-8\?B\?/);
    expect(Buffer.from(raw.split("\r\n\r\n")[1]!.replace(/\r\n/g, ""), "base64").toString("utf8")).toBe("Hello ₹");
  });

  it("drafts, send, labels (creates a missing label once), unlabel, and user address", async () => {
    const f = gmailFake();
    const b = new GoogleGmailBackend(f.api);
    expect(await b.userAddress()).toBe("real.user@gmail.com");
    expect((await b.createDraft({ to: ["a@example.com"], cc: [], bcc: [], subject: "Hi", body: "body" })).subject).toBe("Hi");
    expect(await b.deleteDraft("d1")).toEqual({ deleted: true, id: "d1" });
    const sent = await b.sendEmail({ to: ["a@example.com"], cc: [], bcc: [], subject: "Hi", body: "b" });
    expect(sent.labels).toContain("SENT");
    const e = await b.addLabel("m1", "MUNSHI");
    expect(f.calls.labelCreate).toHaveLength(1);
    expect(e.labels).toContain("MUNSHI");
    await b.addLabel("m1", "munshi");
    expect(f.calls.labelCreate).toHaveLength(1);
    expect((await b.removeLabel("m1", "MUNSHI")).labels).not.toContain("MUNSHI");
    await expect(b.removeLabel("m1", "nope")).rejects.toThrow(/Label not found/);
  });

  it("maps revoked/expired/insufficient grants to a reconnect error", async () => {
    const f = gmailFake();
    (f.api as any).users.messages.list = async () => { throw Object.assign(new Error("invalid_grant"), { response: { status: 400, data: { error: "invalid_grant" } } }); };
    await expect(new GoogleGmailBackend(f.api).listRecentEmails({ limit: 5 })).rejects.toThrow(/^GOOGLE_AUTH: .*revoked/);
    expect(mapGoogleError({ response: { status: 401 }, message: "Unauthorized" })).toBeInstanceOf(GoogleAuthError);
    expect(mapGoogleError({ response: { status: 403, data: { error: { message: "Request had insufficient authentication scopes." } } }, message: "x" }).message).toMatch(/missing a Google permission/);
    const generic = mapGoogleError({ response: { status: 500 }, message: "boom" });
    expect(generic).not.toBeInstanceOf(GoogleAuthError);
    expect(generic.message).toContain("500");
  });
});

describe("GoogleCalendarBackend (fake Calendar API)", () => {
  it("creates events silently (sendUpdates none), maps reminders and all-day events", async () => {
    const inserted: any[] = [];
    const cal = {
      events: {
        insert: async (a: any) => { inserted.push(a); return { data: { id: "g1", summary: a.requestBody.summary, start: a.requestBody.start, end: a.requestBody.end, description: "", attendees: a.requestBody.attendees, reminders: a.requestBody.reminders } }; },
        get: async () => ({ data: { id: "g2", summary: "Holiday", start: { date: "2030-01-26" }, end: { date: "2030-01-27" } } }),
        list: async () => ({ data: { items: [{ id: "g3", summary: "X", start: { dateTime: "2030-01-01T10:00:00+05:30" }, end: { dateTime: "2030-01-01T11:00:00+05:30" } }] } }),
        delete: async () => ({}),
      },
    };
    const b = new GoogleCalendarBackend(cal as never);
    const ev = await b.createEvent({ title: "BESCOM bill due", start: "2030-01-10T10:00:00+05:30", end: "2030-01-10T10:30:00+05:30", description: "", attendees: ["A@x.com"], reminderMinutes: 30 });
    expect(inserted[0]).toMatchObject({ calendarId: "primary", sendUpdates: "none" });
    expect(ev).toMatchObject({ id: "g1", title: "BESCOM bill due", attendees: ["a@x.com"], reminderMinutes: 30 });
    expect((await b.getEvent("g2")).start).toBe("2030-01-26T00:00:00+05:30");
    expect(await b.listEvents({ limit: 5 })).toHaveLength(1);
    expect(await b.deleteEvent("g1")).toEqual({ deleted: true, id: "g1" });
  });
});
