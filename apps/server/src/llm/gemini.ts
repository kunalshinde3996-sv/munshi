import { z } from "zod";
import { LlmError, postJson, type FetchLike, type LlmAdapter, type LlmRequest } from "./types.js";

const Response = z.object({
  candidates: z
    .array(z.object({ content: z.object({ parts: z.array(z.object({ text: z.string().optional() })).optional() }).optional() }))
    .optional(),
});

export class GeminiAdapter implements LlmAdapter {
  readonly provider = "gemini";
  constructor(
    readonly model: string,
    private readonly apiKey: string,
    private readonly fetchFn: FetchLike = fetch as unknown as FetchLike,
  ) {}

  async complete(req: LlmRequest): Promise<string> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`;
    const raw = await postJson(this.fetchFn, url, { "x-goog-api-key": this.apiKey }, {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: "user", parts: [{ text: req.user }] }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: req.maxTokens ?? 2048,
        ...(req.json ? { responseMimeType: "application/json" } : {}),
      },
    });
    const parsed = Response.safeParse(raw);
    const text = parsed.success
      ? parsed.data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("")
      : undefined;
    if (!text) throw new LlmError("Gemini returned no text (possibly blocked or empty candidate)");
    return text;
  }
}
