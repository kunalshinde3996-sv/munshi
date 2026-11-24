import { z } from "zod";
import { LlmError, postJson, withFallback, defaultNet, type FetchLike, type NetOptions } from "./types.js";

/**
 * Tool-calling LLM used ONLY by the Agent runtime. Separate from the text-only `LlmAdapter`
 * used by the Quarantined Extractor, which must stay structurally unable to call tools.
 */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema (object). */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type AgentMessage =
  | { role: "user"; text: string }
  /** `raw` is the provider's own representation, replayed verbatim (needed for signed reasoning parts). */
  | { role: "assistant"; text: string; toolCalls: ToolCall[]; raw?: unknown }
  | { role: "tool"; results: { callId: string; name: string; content: string }[] };

export interface AgentStep {
  text: string;
  toolCalls: ToolCall[];
  raw: unknown;
}

export interface AgentLlm {
  readonly provider: string;
  readonly model: string;
  step(req: { system: string; messages: AgentMessage[]; tools: ToolSpec[] }): Promise<AgentStep>;
}

/** Primary agent model first; fallback model only after the primary exhausted its retries on 429/503/timeout. */
export class FallbackAgentLlm implements AgentLlm {
  constructor(private readonly chain: AgentLlm[], private readonly log: (m: string) => void = defaultNet.log) {}
  get provider() {
    return this.chain[0]!.provider;
  }
  get model() {
    return this.chain[0]!.model;
  }
  step(req: Parameters<AgentLlm["step"]>[0]) {
    return withFallback(this.chain, (a) => a.step(req), this.log);
  }
}

/** Gemini accepts only an OpenAPI-style subset of JSON Schema. */
const GEMINI_KEYS = new Set(["type", "description", "properties", "required", "items", "enum", "minimum", "maximum", "minItems", "maxItems", "nullable"]);
export function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (!schema || typeof schema !== "object") return schema;
  const s = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === "properties" && v && typeof v === "object") {
      out.properties = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, toGeminiSchema(pv)]));
    } else if (GEMINI_KEYS.has(k)) {
      out[k] = k === "items" ? toGeminiSchema(v) : v;
    }
  }
  // anyOf/oneOf with null (optional fields) → take the non-null branch
  const alt = (s.anyOf ?? s.oneOf) as unknown[] | undefined;
  if (alt && !out.type) {
    const real = alt.find((a) => (a as { type?: string }).type !== "null");
    if (real) Object.assign(out, toGeminiSchema(real));
  }
  return out;
}

const GeminiResp = z.object({
  candidates: z.array(z.object({ content: z.object({ parts: z.array(z.record(z.string(), z.unknown())).optional() }).optional() })).optional(),
});

export class GeminiAgentLlm implements AgentLlm {
  readonly provider = "gemini";
  constructor(readonly model: string, private readonly apiKey: string, private readonly fetchFn: FetchLike = fetch as unknown as FetchLike, private readonly net: Partial<NetOptions> = {}) {}

  async step({ system, messages, tools }: Parameters<AgentLlm["step"]>[0]): Promise<AgentStep> {
    const contents = messages.map((m) => {
      if (m.role === "user") return { role: "user", parts: [{ text: m.text }] };
      if (m.role === "assistant") {
        return {
          role: "model",
          parts: (m.raw as unknown[] | undefined) ?? [
            ...(m.text ? [{ text: m.text }] : []),
            ...m.toolCalls.map((c) => ({ functionCall: { name: c.name, args: c.args } })),
          ],
        };
      }
      return {
        role: "user",
        parts: m.results.map((r) => ({ functionResponse: { name: r.name, response: { result: r.content } } })),
      };
    });
    const raw = await postJson(
      this.fetchFn,
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`,
      { "x-goog-api-key": this.apiKey },
      {
        systemInstruction: { parts: [{ text: system }] },
        contents,
        tools: tools.length ? [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: toGeminiSchema(t.parameters) })) }] : undefined,
        toolConfig: tools.length ? { functionCallingConfig: { mode: "AUTO" } } : undefined,
        generationConfig: { temperature: 0, maxOutputTokens: 4096 },
      },
      this.net,
      `gemini/${this.model}`,
    );
    const parsed = GeminiResp.safeParse(raw);
    const parts = parsed.success ? parsed.data.candidates?.[0]?.content?.parts : undefined;
    if (!parts) throw new LlmError("Gemini returned no content (possibly blocked)");
    let n = 0;
    const toolCalls: ToolCall[] = [];
    let text = "";
    for (const p of parts) {
      const fc = p.functionCall as { name?: string; args?: Record<string, unknown>; id?: string } | undefined;
      if (fc?.name) toolCalls.push({ id: fc.id ?? `call-${Date.now()}-${n++}`, name: fc.name, args: fc.args ?? {} });
      else if (typeof p.text === "string" && !p.thought) text += p.text;
    }
    return { text, toolCalls, raw: parts };
  }
}

const AnthropicResp = z.object({ content: z.array(z.record(z.string(), z.unknown())) });

export class AnthropicAgentLlm implements AgentLlm {
  readonly provider = "anthropic";
  constructor(readonly model: string, private readonly apiKey: string, private readonly fetchFn: FetchLike = fetch as unknown as FetchLike, private readonly net: Partial<NetOptions> = {}) {}

  async step({ system, messages, tools }: Parameters<AgentLlm["step"]>[0]): Promise<AgentStep> {
    const wire = messages.map((m) => {
      if (m.role === "user") return { role: "user", content: m.text };
      if (m.role === "assistant") {
        return {
          role: "assistant",
          content: (m.raw as unknown[] | undefined) ?? [
            ...(m.text ? [{ type: "text", text: m.text }] : []),
            ...m.toolCalls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.args })),
          ],
        };
      }
      return { role: "user", content: m.results.map((r) => ({ type: "tool_result", tool_use_id: r.callId, content: r.content })) };
    });
    const raw = await postJson(
      this.fetchFn,
      "https://api.anthropic.com/v1/messages",
      { "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" },
      {
        model: this.model,
        max_tokens: 4096,
        temperature: 0,
        system,
        messages: wire,
        tools: tools.length ? tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) : undefined,
      },
      this.net,
      `anthropic/${this.model}`,
    );
    const parsed = AnthropicResp.safeParse(raw);
    if (!parsed.success) throw new LlmError("Anthropic returned an unexpected response");
    let text = "";
    const toolCalls: ToolCall[] = [];
    for (const b of parsed.data.content) {
      if (b.type === "text" && typeof b.text === "string") text += b.text;
      if (b.type === "tool_use") toolCalls.push({ id: String(b.id), name: String(b.name), args: (b.input as Record<string, unknown>) ?? {} });
    }
    return { text, toolCalls, raw: parsed.data.content };
  }
}
