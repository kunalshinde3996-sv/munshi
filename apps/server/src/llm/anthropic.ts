import { z } from "zod";
import { LlmError, postJson, type FetchLike, type LlmAdapter, type LlmRequest } from "./types.js";

const Response = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
});

export class AnthropicAdapter implements LlmAdapter {
  readonly provider = "anthropic";
  constructor(
    readonly model: string,
    private readonly apiKey: string,
    private readonly fetchFn: FetchLike = fetch as unknown as FetchLike,
  ) {}

  async complete(req: LlmRequest): Promise<string> {
    const raw = await postJson(
      this.fetchFn,
      "https://api.anthropic.com/v1/messages",
      { "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" },
      {
        model: this.model,
        max_tokens: req.maxTokens ?? 2048,
        temperature: 0,
        system: req.system,
        messages: [{ role: "user", content: req.user }],
      },
    );
    const parsed = Response.safeParse(raw);
    const text = parsed.success
      ? parsed.data.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("")
      : undefined;
    if (!text) throw new LlmError("Anthropic returned no text content");
    return text;
  }
}
