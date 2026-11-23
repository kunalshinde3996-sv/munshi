import { randomBytes } from "node:crypto";
import { SANDBOX_USER_EMAIL } from "@munshi/mcp-common";
import { eq } from "drizzle-orm";
import { audit } from "../audit.js";
import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import { schema } from "../db/index.js";
import type { HubOptions } from "../mcp/hub.js";
import { decryptJson, encryptJson, isValidKey } from "./crypto.js";
import { USER_ID } from "../scan.js";

export const REQUIRED_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar.events",
];

/** Everything Google-specific the connection needs; faked in tests, googleapis in production. */
export interface OAuthProvider {
  authUrl(state: string): string;
  exchange(code: string): Promise<{ refreshToken?: string; email: string; scopes: string[] }>;
  revoke(refreshToken: string): Promise<void>;
}

export class GoogleOAuthProvider implements OAuthProvider {
  constructor(private readonly cfg: { clientId: string; clientSecret: string; redirectUri: string }) {}

  private async client() {
    const { google } = await import("googleapis"); // heavy; load lazily
    return new google.auth.OAuth2(this.cfg.clientId, this.cfg.clientSecret, this.cfg.redirectUri);
  }

  authUrl(state: string): string {
    // google-auth-library builds the URL synchronously, but the import is async; construct the URL by hand.
    const q = new URLSearchParams({
      client_id: this.cfg.clientId, redirect_uri: this.cfg.redirectUri, response_type: "code",
      scope: [...REQUIRED_SCOPES].join(" "), access_type: "offline", prompt: "consent", include_granted_scopes: "true", state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
  }

  async exchange(code: string) {
    const c = await this.client();
    const { tokens } = await c.getToken(code);
    c.setCredentials(tokens);
    const { google } = await import("googleapis");
    const profile = await google.gmail({ version: "v1", auth: c }).users.getProfile({ userId: "me" });
    return {
      refreshToken: tokens.refresh_token ?? undefined,
      email: (profile.data.emailAddress ?? "").toLowerCase(),
      scopes: (tokens.scope ?? "").split(" ").filter(Boolean),
    };
  }

  async revoke(refreshToken: string) {
    const c = await this.client();
    await c.revokeToken(refreshToken);
  }
}

interface TokenPayload {
  refreshToken: string;
  email: string;
  scopes: string[];
  connectedAt: number;
}

export type Mode = "sandbox" | "google";

const SETUP_STEPS = [
  "Open console.cloud.google.com, create (or pick) a project, and enable the Gmail API and Google Calendar API.",
  "Under “APIs & Services → OAuth consent screen”, set up an External app in Testing mode and add your Google account as a test user.",
  "Under “Credentials”, create an OAuth client ID of type “Web application”.",
  "Add this exact Authorized redirect URI: {redirectUri}",
  "Copy the client ID and secret into .env as GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.",
  "Generate an encryption key with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\" and put it in .env as TOKEN_ENCRYPTION_KEY.",
  "Restart the server, then press “Connect Google”.",
];

export interface ModeSwitcher {
  reconnect(opts: HubOptions): Promise<void>;
}

/** Owns OAuth state, encrypted token storage, and the per-user sandbox/google mode. */
export class GoogleConnection {
  private states = new Map<string, number>();
  /** Set when a Google tool call reports revoked/expired access; cleared on (re)connect. */
  authProblem: string | null = null;

  constructor(
    private readonly cfg: Pick<Config, "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET" | "GOOGLE_REDIRECT_URI" | "TOKEN_ENCRYPTION_KEY" | "WEB_ORIGIN" | "SANDBOX_STORE_DIR">,
    private readonly db: Db,
    private readonly hub: ModeSwitcher,
    private readonly provider?: OAuthProvider,
    /** Checks that nothing is in flight before the backend is swapped. */
    private readonly busy: () => string | null = () => null,
  ) {}

  static providerFor(cfg: Pick<Config, "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET" | "GOOGLE_REDIRECT_URI">): OAuthProvider | undefined {
    if (!cfg.GOOGLE_CLIENT_ID || !cfg.GOOGLE_CLIENT_SECRET) return undefined;
    return new GoogleOAuthProvider({ clientId: cfg.GOOGLE_CLIENT_ID, clientSecret: cfg.GOOGLE_CLIENT_SECRET, redirectUri: cfg.GOOGLE_REDIRECT_URI });
  }

  missing(): string[] {
    const m: string[] = [];
    if (!this.cfg.GOOGLE_CLIENT_ID) m.push("GOOGLE_CLIENT_ID");
    if (!this.cfg.GOOGLE_CLIENT_SECRET) m.push("GOOGLE_CLIENT_SECRET");
    if (!isValidKey(this.cfg.TOKEN_ENCRYPTION_KEY)) m.push("TOKEN_ENCRYPTION_KEY");
    return m;
  }
  get configured() {
    return this.missing().length === 0 && Boolean(this.provider);
  }

  getMode(): Mode {
    return this.db.select().from(schema.users).where(eq(schema.users.id, USER_ID)).get()?.mode ?? "sandbox";
  }

  private payload(): TokenPayload | null {
    const row = this.db.select().from(schema.oauthTokens).where(eq(schema.oauthTokens.userId, USER_ID)).get();
    if (!row) return null;
    try {
      return decryptJson<TokenPayload>(row.encrypted, this.cfg.TOKEN_ENCRYPTION_KEY);
    } catch {
      return null; // wrong key or tampered: treat as not connected
    }
  }

  status() {
    const p = this.payload();
    return {
      configured: this.configured,
      missing: this.missing(),
      redirectUri: this.cfg.GOOGLE_REDIRECT_URI,
      setupSteps: SETUP_STEPS.map((s) => s.replace("{redirectUri}", this.cfg.GOOGLE_REDIRECT_URI)),
      connected: Boolean(p),
      email: p?.email ?? null,
      mode: this.getMode(),
      authProblem: this.authProblem,
    };
  }

  // ---- OAuth ----

  startUrl(): string {
    if (!this.configured || !this.provider) throw new Error(`Google is not configured (missing ${this.missing().join(", ") || "client credentials"})`);
    const state = randomBytes(24).toString("hex");
    this.states.set(state, Date.now() + 10 * 60_000);
    for (const [s, exp] of this.states) if (exp < Date.now()) this.states.delete(s);
    return this.provider.authUrl(state);
  }

  async handleCallback(code: string | undefined, state: string | undefined): Promise<void> {
    const exp = state ? this.states.get(state) : undefined;
    if (!state || !exp || exp < Date.now()) throw new Error("Invalid or expired OAuth state. Start the connection again.");
    this.states.delete(state);
    if (!code || !this.provider) throw new Error("Missing authorization code");
    const r = await this.provider.exchange(code);
    if (!r.refreshToken) throw new Error("Google did not return a refresh token. Remove Munshi under your Google account's third-party access and connect again.");
    const missing = REQUIRED_SCOPES.filter((s) => !r.scopes.includes(s));
    if (missing.length) throw new Error(`Google did not grant all required permissions (missing: ${missing.map((s) => s.split("/").pop()).join(", ")}).`);
    const payload: TokenPayload = { refreshToken: r.refreshToken, email: r.email, scopes: r.scopes, connectedAt: Date.now() };
    const encrypted = encryptJson(payload, this.cfg.TOKEN_ENCRYPTION_KEY);
    this.db.insert(schema.oauthTokens).values({ userId: USER_ID, provider: "google", encrypted })
      .onConflictDoUpdate({ target: schema.oauthTokens.userId, set: { encrypted, updatedAt: Date.now() } }).run();
    this.authProblem = null;
    audit(this.db, { event: "decision", actor: "user", detail: { google: "connected", email: r.email } });
  }

  async disconnect(): Promise<void> {
    const p = this.payload();
    if (this.getMode() === "google") await this.setMode("sandbox", { force: true });
    if (p && this.provider) await this.provider.revoke(p.refreshToken).catch(() => undefined);
    this.db.delete(schema.oauthTokens).where(eq(schema.oauthTokens.userId, USER_ID)).run();
    this.authProblem = null;
    audit(this.db, { event: "decision", actor: "user", detail: { google: "disconnected" } });
  }

  // ---- mode ----

  hubOptions(mode: Mode): HubOptions {
    if (mode === "sandbox") return { sandboxDir: this.cfg.SANDBOX_STORE_DIR, backend: "sandbox" };
    const p = this.payload();
    if (!p || !this.configured) throw new Error("Google is not connected");
    return {
      sandboxDir: this.cfg.SANDBOX_STORE_DIR, backend: "google",
      env: { GOOGLE_CLIENT_ID: this.cfg.GOOGLE_CLIENT_ID!, GOOGLE_CLIENT_SECRET: this.cfg.GOOGLE_CLIENT_SECRET!, GOOGLE_REFRESH_TOKEN: p.refreshToken },
    };
  }

  /** Hub options for server start: honours the saved mode, falling back to sandbox (and saying so) if Google is unusable. */
  startupHubOptions(): HubOptions {
    if (this.getMode() === "google") {
      try {
        return this.hubOptions("google");
      } catch {
        this.db.update(schema.users).set({ mode: "sandbox", email: SANDBOX_USER_EMAIL }).where(eq(schema.users.id, USER_ID)).run();
        console.warn("Saved mode was google but Google is not usable (not configured / not connected); starting in sandbox mode.");
      }
    }
    return this.hubOptions("sandbox");
  }

  async setMode(mode: Mode, opts: { force?: boolean } = {}): Promise<Mode> {
    if (mode === this.getMode()) return mode;
    if (mode === "google") {
      if (!this.configured) throw new Error(`Google is not configured (missing ${this.missing().join(", ")}).`);
      if (!this.payload()) throw new Error("Connect Google first.");
    }
    const why = opts.force ? null : this.busy();
    if (why) throw new Error(`Can't switch while work is in progress: ${why}`);
    await this.hub.reconnect(this.hubOptions(mode));
    const own = mode === "google" ? this.payload()!.email : SANDBOX_USER_EMAIL;
    // The user's own address is TRUSTED provenance: it must follow the active mailbox.
    this.db.update(schema.users).set({ mode, email: own }).where(eq(schema.users.id, USER_ID)).run();
    this.authProblem = null;
    audit(this.db, { event: "decision", actor: "user", detail: { mode } });
    return mode;
  }
}

/** Why switching backends right now would be unsafe, or null. */
export function busyReason(db: Db): string | null {
  const run = db.select().from(schema.agentRuns).all().find((r) => r.status === "running" || r.status === "awaiting_approval");
  if (run) return `agent run ${run.id} is ${run.status.replace("_", " ")}`;
  const open = db.select().from(schema.actions).all().find((a) => a.status === "pending_approval" || a.status === "held" || a.status === "approved");
  if (open) return `action ${open.id} is ${open.status.replace("_", " ")}`;
  return null;
}
