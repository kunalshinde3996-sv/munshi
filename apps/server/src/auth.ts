import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { eq, lt } from "drizzle-orm";
import { audit } from "./audit.js";
import { schema, type Db } from "./db/index.js";
import { USER_ID } from "./scan.js";

/** Single-user authentication: scrypt password hashes, server-side sessions, httpOnly SameSite=Strict cookie. */
export const SESSION_COOKIE = "munshi_session";
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const LOGIN_MAX_PER_MINUTE = 5;

const N = 16384, R = 8, P = 1, KEYLEN = 32;

function scryptAsync(password: string, salt: Buffer, n = N, r = R, p = P): Promise<Buffer> {
  return new Promise((res, rej) => scrypt(password, salt, KEYLEN, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? rej(e) : res(k))));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, saltB64, hashB64] = stored.split("$");
  if (alg !== "scrypt" || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const got = await scryptAsync(password, Buffer.from(saltB64, "base64"), Number(n), Number(r), Number(p));
  return got.length === expected.length && timingSafeEqual(got, expected);
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const normEmail = (e: string) => e.trim().toLowerCase();

/** Fixed-window limiter: at most `max` attempts per key per minute. */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private readonly max = LOGIN_MAX_PER_MINUTE, private readonly windowMs = 60_000, private readonly now: () => number = Date.now) {}
  /** Records an attempt; returns the seconds to wait if the key is over the limit, else 0. */
  hit(key: string): number {
    const t = this.now();
    const arr = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (arr.length >= this.max) {
      this.hits.set(key, arr);
      return Math.max(1, Math.ceil((this.windowMs - (t - arr[0]!)) / 1000));
    }
    arr.push(t);
    this.hits.set(key, arr);
    return 0;
  }
}

export interface SessionInfo {
  email: string;
  expiresAt: number;
}

/** Creates the demo login from env, or refreshes its password hash when the env password changed. Returns false when unset. */
export async function seedDemoUser(db: Db, email: string | undefined, password: string | undefined): Promise<boolean> {
  if (!email || !password) return false;
  const e = normEmail(email);
  const row = db.select().from(schema.authUsers).where(eq(schema.authUsers.email, e)).get();
  if (row && (await verifyPassword(password, row.passwordHash))) return true;
  const passwordHash = await hashPassword(password);
  if (row) db.update(schema.authUsers).set({ passwordHash }).where(eq(schema.authUsers.id, row.id)).run();
  else db.insert(schema.authUsers).values({ id: `auth-${randomUUID().slice(0, 8)}`, email: e, passwordHash, userId: USER_ID }).run();
  return true;
}

// A real hash to compare against when the email is unknown, so unknown-user and wrong-password take the same time.
let dummyHash: Promise<string> | undefined;

export class AuthService {
  constructor(private readonly db: Db, private readonly now: () => number = Date.now) {}

  /** Returns a new raw session token, or null for bad credentials. */
  async login(email: string, password: string): Promise<{ token: string; session: SessionInfo } | null> {
    const row = this.db.select().from(schema.authUsers).where(eq(schema.authUsers.email, normEmail(email))).get();
    dummyHash ??= hashPassword("not-a-real-password");
    const ok = await verifyPassword(password, row?.passwordHash ?? (await dummyHash));
    if (!row || !ok) {
      audit(this.db, { event: "login_failed", actor: "system", detail: { email: normEmail(email).slice(0, 120) } });
      return null;
    }
    return this.openSession(row, false);
  }

  /**
   * Passwordless login of the seeded demo user. The CALLER must have verified that demo mode is on; this never takes
   * a client-supplied email. Returns null when the demo user has not been seeded.
   */
  loginDemo(demoEmail: string | undefined): { token: string; session: SessionInfo } | null {
    if (!demoEmail) return null;
    const row = this.db.select().from(schema.authUsers).where(eq(schema.authUsers.email, normEmail(demoEmail))).get();
    return row ? this.openSession(row, true) : null;
  }

  private openSession(row: typeof schema.authUsers.$inferSelect, demo: boolean): { token: string; session: SessionInfo } {
    this.db.delete(schema.sessions).where(lt(schema.sessions.expiresAt, this.now())).run();
    const token = randomBytes(32).toString("base64url");
    const expiresAt = this.now() + SESSION_TTL_MS;
    this.db.insert(schema.sessions).values({ id: sha256(token), authUserId: row.id, createdAt: this.now(), expiresAt }).run();
    audit(this.db, { event: "login", actor: "user", detail: { email: row.email, method: demo ? "demo_account" : "password" } });
    return { token, session: { email: row.email, expiresAt } };
  }

  /** Valid session for a raw token, or null (unknown / expired). */
  check(token: string | undefined): SessionInfo | null {
    if (!token) return null;
    const s = this.db.select().from(schema.sessions).where(eq(schema.sessions.id, sha256(token))).get();
    if (!s) return null;
    if (s.expiresAt <= this.now()) {
      this.db.delete(schema.sessions).where(eq(schema.sessions.id, s.id)).run();
      return null;
    }
    const u = this.db.select().from(schema.authUsers).where(eq(schema.authUsers.id, s.authUserId)).get();
    return u ? { email: u.email, expiresAt: s.expiresAt } : null;
  }

  logout(token: string | undefined): void {
    if (!token) return;
    const id = sha256(token);
    const s = this.db.select().from(schema.sessions).where(eq(schema.sessions.id, id)).get();
    if (!s) return;
    this.db.delete(schema.sessions).where(eq(schema.sessions.id, id)).run();
    audit(this.db, { event: "logout", actor: "user", detail: {} });
  }
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

export const sessionCookie = (token: string, maxAgeSec = SESSION_TTL_MS / 1000) =>
  `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}`;
export const clearedCookie = () => `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
