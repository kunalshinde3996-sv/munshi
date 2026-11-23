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
