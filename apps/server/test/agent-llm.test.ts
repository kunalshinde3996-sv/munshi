import { describe, expect, it } from "vitest";
import { AnthropicAgentLlm, GeminiAgentLlm, toGeminiSchema, type AgentMessage, type FetchLike } from "../src/llm/index.js";

function fakeFetch(body: unknown) {
  const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  return { fn, calls };
}
const tools = [{ name: "create_event", description: "d", parameters: { type: "object", properties: { title: { type: "string", format: "email", default: "x" } }, required: ["title"], additionalProperties: false, $schema: "http://json-schema.org/draft-07/schema#" } }];
const history: AgentMessage[] = [
  { role: "user", text: "goal" },
  { role: "assistant", text: "", toolCalls: [{ id: "c1", name: "create_event", args: { title: "T" } }] },
  { role: "tool", results: [{ callId: "c1", name: "create_event", content: "ok" }] },
];

describe("tool-calling agent adapters", () => {
  it("Gemini: declares tools with a sanitized schema, replays raw parts, parses functionCall", async () => {
    const f = fakeFetch({ candidates: [{ content: { parts: [{ text: "thinking", thought: true }, { functionCall: { name: "create_event", args: { title: "X" } }, thoughtSignature: "sig" }] } }] });
    const out = await new GeminiAgentLlm("m", "KEY", f.fn).step({ system: "S", messages: [...history.slice(0, 1), { role: "assistant", text: "", toolCalls: [], raw: [{ functionCall: { name: "a", args: {} }, thoughtSignature: "s0" }] }, history[2]!], tools });
    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolCalls[0]).toMatchObject({ name: "create_event", args: { title: "X" } });
    expect(out.text).toBe(""); // thought parts are not surfaced
    expect(out.raw).toEqual([{ text: "thinking", thought: true }, { functionCall: { name: "create_event", args: { title: "X" } }, thoughtSignature: "sig" }]);
    const b = f.calls[0]!.body;
    expect(f.calls[0]!.headers["x-goog-api-key"]).toBe("KEY");
    expect(b.tools[0].functionDeclarations[0].parameters).toEqual({ type: "object", properties: { title: { type: "string" } }, required: ["title"] });
    expect(b.contents[1]).toEqual({ role: "model", parts: [{ functionCall: { name: "a", args: {} }, thoughtSignature: "s0" }] });
    expect(b.contents[2].parts[0].functionResponse).toEqual({ name: "create_event", response: { result: "ok" } });
  });

  it("Anthropic: declares tools, maps tool results, parses tool_use", async () => {
    const f = fakeFetch({ content: [{ type: "text", text: "hi" }, { type: "tool_use", id: "tu1", name: "create_event", input: { title: "X" } }] });
    const out = await new AnthropicAgentLlm("m", "KEY", f.fn).step({ system: "S", messages: history, tools });
    expect(out).toMatchObject({ text: "hi", toolCalls: [{ id: "tu1", name: "create_event", args: { title: "X" } }] });
    const b = f.calls[0]!.body;
    expect(b.tools[0].input_schema.type).toBe("object");
    expect(b.messages[1].content[0]).toMatchObject({ type: "tool_use", id: "c1" });
    expect(b.messages[2].content[0]).toEqual({ type: "tool_result", tool_use_id: "c1", content: "ok" });
  });

  it("toGeminiSchema drops unsupported keywords and unwraps nullable anyOf", () => {
    expect(toGeminiSchema({ anyOf: [{ type: "string" }, { type: "null" }] })).toEqual({ type: "string" });
  });
});
