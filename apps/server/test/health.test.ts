import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openDb, schema } from "../src/db/index.js";

describe("server shell", () => {
  it("GET /api/health returns ok", async () => {
    const config = loadConfig({});
    const { db } = openDb(":memory:");
    const app = buildApp({ config, db });
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, service: "munshi-server" });
  });

  it("migrations create the schema and DB accepts inserts", () => {
    const { db } = openDb(":memory:");
    db.insert(schema.users).values({ id: "u1", email: "me@example.com" }).run();
    const rows = db.select().from(schema.users).all();
    expect(rows[0]?.mode).toBe("sandbox");
    db.insert(schema.auditLog).values({ event: "proposed", actor: "agent", detail: "{}" }).run();
    expect(db.select().from(schema.auditLog).all()).toHaveLength(1);
  });
});
