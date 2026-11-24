import type { LlmAdapter, LlmRequest } from "../src/llm/types.js";

/** Test-only scripted LLM. Records every request so tests can assert on exactly what the model saw. */
export class MockLlm implements LlmAdapter {
  readonly provider = "mock";
  readonly model = "mock-1";
  readonly calls: LlmRequest[] = [];
  constructor(private readonly respond: (req: LlmRequest, call: number) => string | Promise<string>) {}
  async complete(req: LlmRequest) {
    this.calls.push(req);
    return this.respond(req, this.calls.length);
  }
}

export const obligationJson = (o: Record<string, unknown>) =>
  JSON.stringify({ obligations: [{ dueDate: null, amount: null, currency: null, counterparty: null, confidence: 0.9, ...o }] });

import type { AgentLlm, AgentMessage, AgentStep, ToolCall, ToolSpec } from "../src/llm/agent.js";

/** Test-only scripted tool-calling agent. Records what the model was shown. */
export class MockAgent implements AgentLlm {
  readonly provider = "mock";
  readonly model = "mock-agent";
  readonly seen: { messages: AgentMessage[]; tools: ToolSpec[] }[] = [];
  constructor(private readonly script: (messages: AgentMessage[], call: number) => { text?: string; toolCalls?: Omit<ToolCall, "id">[] }) {}
  async step(req: { system: string; messages: AgentMessage[]; tools: ToolSpec[] }): Promise<AgentStep> {
    this.seen.push({ messages: structuredClone(req.messages), tools: req.tools });
    const out = this.script(req.messages, this.seen.length);
    const toolCalls = (out.toolCalls ?? []).map((c, i) => ({ id: `t${this.seen.length}-${i}`, ...c }));
    return { text: out.text ?? "", toolCalls, raw: undefined };
  }
}

/** Pull the obligation list the runtime put in the first user message. */
export function obligationsFrom(messages: AgentMessage[]): { id: string; type: string; title: string; senderAddress: string; confidence: number }[] {
  const first = messages[0] as { text: string };
  const m = /<untrusted_obligations>\n([\s\S]*?)\n<\/untrusted_obligations>/.exec(first.text);
  return JSON.parse(m![1]!);
}

import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Db } from "../src/db/index.js";
import { schema } from "../src/db/index.js";
import { SESSION_COOKIE } from "../src/auth.js";
import { USER_ID } from "../src/scan.js";

/**
 * Gives an app a real server-side session (same table/cookie the login route uses) and makes `app.inject` send it,
 * so tests exercise the authenticated API. Login/logout/rate-limit behaviour is tested separately in auth.test.ts.
 */
export function withSession<T extends FastifyInstance>(app: T, db: Db, email = "tester@munshi.local"): T {
  const token = randomBytes(24).toString("base64url");
  const existing = db.select().from(schema.users).all().length;
  if (!existing) db.insert(schema.users).values({ id: USER_ID, email: "tester@example.com" }).onConflictDoNothing().run();
  const authId = `auth-${token.slice(0, 6)}`;
  db.insert(schema.authUsers).values({ id: authId, email: `${authId}-${email}`, passwordHash: "x", userId: USER_ID }).run();
  db.insert(schema.sessions).values({ id: createHash("sha256").update(token).digest("hex"), authUserId: authId, expiresAt: Date.now() + 3_600_000 }).run();
  const orig = app.inject.bind(app) as (o: unknown) => unknown;
  (app as unknown as { inject: (o: unknown) => unknown }).inject = (opts: unknown) => {
    const o = (typeof opts === "string" ? { url: opts } : opts) as { headers?: Record<string, string> };
    return orig({ ...o, headers: { cookie: `${SESSION_COOKIE}=${token}`, ...(o.headers ?? {}) } });
  };
  return app;
}
