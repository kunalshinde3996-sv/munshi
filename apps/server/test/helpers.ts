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
