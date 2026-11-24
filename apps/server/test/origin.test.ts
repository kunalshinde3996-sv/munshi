import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { makeOriginPolicy } from "../src/origin.js";
import { ensureUser } from "../src/scan.js";
import { withSession } from "./helpers.js";

async function post(origin: string, env: Record<string, string> = {}) {
  const { db } = openDb(":memory:");
  ensureUser(db);
  const app = buildApp({ config: loadConfig(env), db });
  withSession(app, db);
  return app.inject({ method: "POST", url: "/api/scan", headers: { origin }, payload: {} });
}

describe("origin policy", () => {
  it("allows localhost on any port and 127.0.0.1 on any port", async () => {
    for (const o of ["http://localhost:5174", "http://127.0.0.1:5173", "http://localhost:5173", "http://127.0.0.1:6000"]) {
      expect((await post(o)).statusCode, o).not.toBe(403);
    }
  });
  it("rejects other origins, including lookalikes", async () => {
    for (const o of ["http://evil.example", "http://localhost.evil.example:5173", "https://localhost:5173", "http://evil.example:5173"]) {
      const r = await post(o);
      expect(r.statusCode, o).toBe(403);
      expect(r.json().error).toBe("Cross-origin request blocked");
    }
  });
  it("ALLOWED_ORIGINS adds exact origins", async () => {
    expect((await post("http://munshi.lan:3000", { ALLOWED_ORIGINS: "http://munshi.lan:3000, http://x.example" })).statusCode).not.toBe(403);
    expect((await post("http://munshi.lan:3000")).statusCode).toBe(403);
  });
  it("production allows only configured origins", () => {
    const p = makeOriginPolicy({ webOrigin: "http://localhost:5173", port: 8787, production: true });
    expect(p.isAllowed("http://localhost:5173")).toBe(true);
    expect(p.isAllowed("http://localhost:5174")).toBe(false);
  });
});
