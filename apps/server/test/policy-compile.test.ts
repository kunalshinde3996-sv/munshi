import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openDb, schema } from "../src/db/index.js";
import { COMPILER_SYSTEM, compilePolicy, describeRule, PolicyCompileError, PolicyDrafts } from "../src/guard/policy-compile.js";
import { evaluatePolicies, PolicyRule } from "../src/guard/policy.js";
import { ensureUser } from "../src/scan.js";
import { MockLlm, withSession } from "./helpers.js";

const professorRule = {
  description: "Ask before emailing my professor",
  match: { tool: "send_email", argsCondition: { to: { contains: "professor" } } },
  decision: "require_approval",
  reason: "You asked to be asked before anything is emailed to your professor.",
};
const reply = (o: unknown) => JSON.stringify(o);

describe("plain-language policy compiler", () => {
  it("compiles a sentence into a validated rule with a deterministic readback; id is server-assigned", async () => {
    const llm = new MockLlm(() => reply({ rule: { ...professorRule, id: "seed-never-auto-send" } })); // LLM tries to pick a colliding id
    const out = await compilePolicy(llm, "never email my professor without asking");
    expect(PolicyRule.safeParse(out.rule).success).toBe(true);
    expect(out.rule.id).toMatch(/^user-[0-9a-f]{6}$/);
    expect(out.readback).toBe('Whenever the agent calls send_email and to contains "professor", pause and ask for your approval first.');
    expect(out.warnings.join(" ")).toContain("already always needs your approval");
    // the model only saw the user's own sentence plus the tool list (no email content)
    expect(llm.calls[0]!.system).toBe(COMPILER_SYSTEM);
    expect(llm.calls[0]!.system).toContain("create_event (R1); args: title, start");
    expect(llm.calls[0]!.user).toContain("never email my professor without asking");
    // and the compiled rule really does what the readback says
    const facts = { tool: "send_email", args: { to: ["prof.rao@professor-dept.example"] }, tainted: false, allSensitiveAllowlisted: true };
    expect(evaluatePolicies([out.rule], facts).winner?.decision).toBe("require_approval");
    expect(evaluatePolicies([out.rule], { ...facts, args: { to: ["mom@example.com"] } }).winner).toBeNull();
  });

  it("invalid compile: retries once with the error, then gives a clear message; nothing is returned", async () => {
    const llm = new MockLlm((_req, n) => reply(n === 1 ? { rule: { ...professorRule, match: { tool: "delete_event" } } } : { rule: { ...professorRule, match: { tool: "send_email", argsCondition: { recipient: "x" } } } }));
    await expect(compilePolicy(llm, "never email my professor")).rejects.toThrow(/Couldn't turn that into a valid rule .*no argument “recipient”/);
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1]!.user).toContain("not a tool the agent can call");
  });

  it("recovers on the retry; rejects garbage, wrong decision values, '*' with args; honours an explicit 'cannot express'", async () => {
    const ok = new MockLlm((_r, n) => (n === 1 ? "sorry, I cannot do that" : reply({ rule: professorRule })));
    expect((await compilePolicy(ok, "never email my professor")).rule.match.tool).toBe("send_email");
    const bad = (rule: unknown) => compilePolicy(new MockLlm(() => reply({ rule })), "some rule here");
    await expect(bad({ ...professorRule, decision: "yolo" })).rejects.toBeInstanceOf(PolicyCompileError);
    await expect(bad({ ...professorRule, match: { tool: "*", argsCondition: { to: "x" } } })).rejects.toThrow(/specific tool/);
    await expect(bad({ ...professorRule, extra: 1 })).rejects.toBeInstanceOf(PolicyCompileError);
    const no = new MockLlm(() => reply({ error: "There is no tool that deletes files." }));
    await expect(compilePolicy(no, "delete my files at night")).rejects.toThrow("This rule can't be expressed: There is no tool that deletes files.");
    expect(no.calls).toHaveLength(1); // a deliberate refusal is not retried
  });

  it("describeRule covers conditions; allow rules get a loosening warning", async () => {
    const r = PolicyRule.parse({ id: "x", match: { tool: "create_event", tainted: false, minObligationConfidence: 0.9, argsCondition: { title: { contains: "rent" } } }, decision: "allow", reason: "r" });
    expect(describeRule(r)).toBe('Whenever the agent calls create_event and title contains "rent" and no value came from email content and the obligation\'s extraction confidence is at least 0.9, allow it automatically (the Guard\'s built-in protections still apply).');
    const out = await compilePolicy(new MockLlm(() => reply({ rule: { match: { tool: "create_event" }, decision: "allow", reason: "r" } })), "just make my reminders");
    expect(out.warnings[0]).toContain("act without asking");
  });

  it("drafts are single-use and expire", () => {
    let t = 0;
    const d = new PolicyDrafts(1000, () => t);
    const c = { rule: PolicyRule.parse({ id: "a", match: { tool: "*" }, decision: "block", reason: "r" }), readback: "", warnings: [] };
    const { id } = d.add(c, "text");
    expect(d.take(id)?.text).toBe("text");
    expect(d.take(id)).toBeNull();
    const second = d.add(c, "t2");
    t = 5000;
    expect(d.take(second.id)).toBeNull();
  });
});

describe("policy compile API: LLM can only propose; the user's confirm saves", () => {
  function app(llm: MockLlm | undefined) {
    const { db } = openDb(":memory:");
    ensureUser(db);
    return { db, app: withSession(buildApp({ config: loadConfig({}), db, llm, llmError: llm ? undefined : "LLM_MODEL is not set in .env" }), db) };
  }
  const policyIds = (db: ReturnType<typeof openDb>["db"]) => db.select().from(schema.policies).all().map((p) => p.id);

  it("compile does NOT save; confirm saves exactly the shown rule once, and both steps are audited", async () => {
    const { db, app: a } = app(new MockLlm(() => reply({ rule: professorRule })));
    const before = policyIds(db).length;
    const res = await a.inject({ method: "POST", url: "/api/policies/compile", payload: { text: "never email my professor without asking" } });
    expect(res.statusCode).toBe(200);
    const draft = res.json();
    expect(draft.readback).toContain("send_email");
    expect(policyIds(db)).toHaveLength(before); // nothing active yet

    const ok = await a.inject({ method: "POST", url: `/api/policies/compile/${draft.draftId}/confirm` });
    expect(ok.statusCode).toBe(200);
    const saved = db.select().from(schema.policies).where(eq(schema.policies.id, draft.rule.id)).get()!;
    expect(JSON.parse(saved.ruleJson)).toEqual(draft.rule);
    expect(saved.enabled).toBe(true);
    expect(policyIds(db)).toHaveLength(before + 1);

    expect((await a.inject({ method: "POST", url: `/api/policies/compile/${draft.draftId}/confirm` })).statusCode).toBe(404); // single use
    const events = db.select().from(schema.auditLog).all().map((e) => e.event);
    expect(events).toEqual(expect.arrayContaining(["policy_proposed", "policy_confirmed"]));
    const list = (await a.inject({ method: "GET", url: "/api/policies" })).json().policies;
    expect(list.find((p: any) => p.id === draft.rule.id)).toMatchObject({ valid: true, seed: false });
  });

  it("discarded drafts cannot be confirmed; invalid compile -> 422 with a clear error; no LLM -> 503", async () => {
    const { db, app: a } = app(new MockLlm(() => reply({ rule: professorRule })));
    const d = (await a.inject({ method: "POST", url: "/api/policies/compile", payload: { text: "never email my professor" } })).json();
    await a.inject({ method: "DELETE", url: `/api/policies/compile/${d.draftId}` });
    expect((await a.inject({ method: "POST", url: `/api/policies/compile/${d.draftId}/confirm` })).statusCode).toBe(404);

    const bad = app(new MockLlm(() => "not json at all"));
    const r = await bad.app.inject({ method: "POST", url: "/api/policies/compile", payload: { text: "do something odd" } });
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toContain("Couldn't turn that into a valid rule");
    expect(policyIds(bad.db).some((id) => id.startsWith("user-"))).toBe(false);

    expect((await app(undefined).app.inject({ method: "POST", url: "/api/policies/compile", payload: { text: "never email my professor" } })).statusCode).toBe(503);
    expect((await a.inject({ method: "POST", url: "/api/policies/compile", payload: { text: "no" } })).statusCode).toBe(400);
    void db;
  });
});
