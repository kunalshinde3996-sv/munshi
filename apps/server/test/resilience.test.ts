import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { installCrashHandlers } from "../src/crash-log.js";
import { openDb } from "../src/db/index.js";
import { ensureUser } from "../src/scan.js";
import { createServices } from "../src/services.js";
import { MockAgent, withSession } from "./helpers.js";

describe("crash handlers", () => {
  it("logs rejections and exceptions to the file and keeps going; exits on a burst", () => {
    const dir = mkdtempSync(join(tmpdir(), "munshi-crash-"));
    const file = join(dir, "nested", "server-error.log");
    const proc = new EventEmitter() as unknown as NodeJS.Process;
    const exit = vi.fn();
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    installCrashHandlers(file, 2, proc, exit);
    proc.emit("unhandledRejection", new Error("boom-1"));
    proc.emit("uncaughtException", new Error("boom-2"));
    const text = readFileSync(file, "utf8");
    expect(text).toContain("unhandledRejection");
    expect(text).toContain("boom-1");
    expect(text).toContain("uncaughtException");
    expect(exit).not.toHaveBeenCalled();
    proc.emit("unhandledRejection", "string reason");
    expect(exit).toHaveBeenCalledWith(1);
    spy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("default sandbox inbox and clean API errors", () => {
  it("SANDBOX_ATTACK_EMAILS defaults to off", () => {
    expect(loadConfig({}).SANDBOX_ATTACK_EMAILS).toBe(false);
  });

  it("a crashing agent fails the run cleanly and the API keeps answering with JSON", async () => {
    const { db } = openDb(":memory:");
    ensureUser(db);
    const config = loadConfig({ LLM_PROVIDER: "replay" });
    const agent = new MockAgent(() => { throw new Error("agent exploded"); });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const services = createServices({ config, db, mcp: { toolInfos: [] } as never, agent });
    const app = withSession(buildApp({ config, db, mcp: undefined, services }), db);
    const res = await app.inject({ method: "POST", url: "/api/runs", payload: { goal: "do the things" } });
    expect(res.statusCode).toBe(200);
    await services.runtime!.whenIdle();
    const run = (await app.inject({ method: "GET", url: `/api/runs/${res.json().runId}` })).json();
    expect(run.run.status).toBe("failed");
    expect(JSON.stringify(run.trace)).toContain("agent exploded");
    // validation errors and unknown routes are JSON too
    const bad = await app.inject({ method: "POST", url: "/api/runs", payload: { goal: "x" } });
    expect(bad.statusCode).toBe(400);
    expect(typeof bad.json().error).toBe("string");
    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
    spy.mockRestore();
  });
});
