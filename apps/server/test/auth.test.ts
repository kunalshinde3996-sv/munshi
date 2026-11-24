import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { AuthService, RateLimiter, SESSION_TTL_MS, hashPassword, seedDemoUser, verifyPassword } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { ensureUser } from "../src/scan.js";

const EMAIL = "demo@munshi.local";
const PASSWORD = "correct horse battery";

async function setup() {
  const { db } = openDb(":memory:");
  ensureUser(db);
  await seedDemoUser(db, EMAIL, PASSWORD);
  const app = buildApp({ config: loadConfig({}), db });
  const login = (email = EMAIL, password = PASSWORD) => app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  return { db, app, login };
}
const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers["set-cookie"]).split(";")[0]!;

describe("authentication", () => {
  it("no session -> 401 on every /api route except health and auth; health stays public", async () => {
    const { app } = await setup();
    for (const [method, url] of [["GET", "/api/obligations"], ["GET", "/api/emails"], ["POST", "/api/scan"], ["GET", "/api/actions"], ["POST", "/api/runs"], ["GET", "/api/audit"], ["GET", "/api/policies"], ["GET", "/api/security"], ["GET", "/api/auth/me"], ["GET", "/auth/google/start"]] as const) {
      const r = await app.inject({ method, url });
      expect(r.statusCode, `${method} ${url}`).toBe(401);
      expect(r.json().error).toBe("Not signed in");
    }
    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
  });

  it("a made-up or empty cookie is rejected", async () => {
    const { app } = await setup();
    expect((await app.inject({ method: "GET", url: "/api/obligations", headers: { cookie: "munshi_session=forged" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/obligations", headers: { cookie: "munshi_session=" } })).statusCode).toBe(401);
  });

  it("wrong password and unknown email -> 401 with no cookie, and the same message", async () => {
    const { login } = await setup();
    const a = await login(EMAIL, "nope");
    const b = await login("someone@else.example", PASSWORD);
    expect(a.statusCode).toBe(401);
    expect(b.statusCode).toBe(401);
    expect(a.headers["set-cookie"]).toBeUndefined();
    expect(a.json().error).toBe(b.json().error);
  });

  it("good login sets an httpOnly SameSite=Strict 12h cookie that unlocks the API; email is case-insensitive", async () => {
    const { app, login } = await setup();
    const r = await login("DEMO@Munshi.Local");
    expect(r.statusCode).toBe(200);
    const set = String(r.headers["set-cookie"]);
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/SameSite=Strict/);
    expect(set).toContain(`Max-Age=${SESSION_TTL_MS / 1000}`);
    const cookie = cookieOf(r);
    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe(EMAIL);
    expect((await app.inject({ method: "GET", url: "/api/obligations", headers: { cookie } })).statusCode).toBe(200);
  });

  it("logout invalidates the session server-side (the old cookie stops working)", async () => {
    const { app, login } = await setup();
    const cookie = cookieOf(await login());
    expect((await app.inject({ method: "GET", url: "/api/obligations", headers: { cookie } })).statusCode).toBe(200);
    const out = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } });
    expect(out.statusCode).toBe(200);
    expect(String(out.headers["set-cookie"])).toMatch(/Max-Age=0/);
    expect((await app.inject({ method: "GET", url: "/api/obligations", headers: { cookie } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } })).statusCode).toBe(401);
  });

  it("login is rate limited: the 6th attempt within a minute gets 429, even with the right password", async () => {
    const { login } = await setup();
    for (let i = 0; i < 5; i++) expect((await login(EMAIL, `bad-${i}`)).statusCode).toBe(401);
    const r = await login(EMAIL, PASSWORD);
    expect(r.statusCode).toBe(429);
    expect(Number(r.headers["retry-after"])).toBeGreaterThan(0);
    expect(r.headers["set-cookie"]).toBeUndefined();
  });

  it("the cross-origin check still applies to authenticated writes", async () => {
    const { app, login } = await setup();
    const cookie = cookieOf(await login());
    const r = await app.inject({ method: "POST", url: "/api/scan", headers: { cookie, origin: "http://evil.example" }, payload: {} });
    expect(r.statusCode).toBe(403);
  });

  it("sessions expire after 12h", async () => {
    const { db } = await setup();
    let t = 1_000_000;
    const svc = new AuthService(db, () => t);
    const { token } = (await svc.login(EMAIL, PASSWORD))!;
    expect(svc.check(token)).not.toBeNull();
    t += SESSION_TTL_MS - 1;
    expect(svc.check(token)).not.toBeNull();
    t += 2;
    expect(svc.check(token)).toBeNull();
  });
});

describe("password hashing and limiter", () => {
  it("scrypt hashes are salted and verify only the right password", async () => {
    const a = await hashPassword("pw-1");
    const b = await hashPassword("pw-1");
    expect(a).not.toBe(b);
    expect(a.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("pw-1", a)).toBe(true);
    expect(await verifyPassword("pw-2", a)).toBe(false);
    expect(await verifyPassword("pw-1", "garbage")).toBe(false);
  });

  it("seeding refreshes the hash when the env password changes, and does nothing when unset", async () => {
    const { db } = openDb(":memory:");
    ensureUser(db);
    expect(await seedDemoUser(db, undefined, undefined)).toBe(false);
    await seedDemoUser(db, EMAIL, "first");
    const svc = new AuthService(db);
    expect(await svc.login(EMAIL, "first")).not.toBeNull();
    await seedDemoUser(db, EMAIL, "second");
    expect(await svc.login(EMAIL, "first")).toBeNull();
    expect(await svc.login(EMAIL, "second")).not.toBeNull();
  });

  it("RateLimiter allows `max` per window then recovers", () => {
    let t = 0;
    const rl = new RateLimiter(2, 60_000, () => t);
    expect(rl.hit("k")).toBe(0);
    expect(rl.hit("k")).toBe(0);
    expect(rl.hit("k")).toBeGreaterThan(0);
    expect(rl.hit("other")).toBe(0);
    t = 60_001;
    expect(rl.hit("k")).toBe(0);
  });
});
