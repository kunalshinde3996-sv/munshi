import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { AnthropicAdapter, createLlm, FallbackLlm, GeminiAdapter, LlmError, type FetchLike } from "../src/llm/index.js";

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return { ok: status < 300, status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
  };
  return { fn, calls };
}

describe("LLM adapters", () => {
  it("Gemini: sends system + user + JSON mode, parses text, key only in header", async () => {
    const f = fakeFetch(200, { candidates: [{ content: { parts: [{ text: '{"a":' }, { text: "1}" }] } }] });
    const out = await new GeminiAdapter("model-x", "KEY", f.fn).complete({ system: "S", user: "U", json: true });
    expect(out).toBe('{"a":1}');
    const c = f.calls[0]!;
    expect(c.url).toContain("/models/model-x:generateContent");
    expect(c.url).not.toContain("KEY");
    expect(c.headers["x-goog-api-key"]).toBe("KEY");
    expect(c.body.systemInstruction.parts[0].text).toBe("S");
    expect(c.body.contents[0].parts[0].text).toBe("U");
    expect(c.body.generationConfig.responseMimeType).toBe("application/json");
    expect(c.body.tools).toBeUndefined(); // no tool surface
  });

  it("Anthropic: sends model/system/messages, parses text blocks, no tools", async () => {
    const f = fakeFetch(200, { content: [{ type: "text", text: "hello" }] });
    const out = await new AnthropicAdapter("model-y", "KEY", f.fn).complete({ system: "S", user: "U" });
    expect(out).toBe("hello");
    const c = f.calls[0]!;
    expect(c.headers["x-api-key"]).toBe("KEY");
    expect(c.body).toMatchObject({ model: "model-y", system: "S", messages: [{ role: "user", content: "U" }] });
    expect(c.body.tools).toBeUndefined();
  });

  it("auth/model errors are fatal; rate limits are not", async () => {
    const bad = new GeminiAdapter("m", "k", fakeFetch(401, "nope").fn);
    await expect(bad.complete({ system: "", user: "" })).rejects.toMatchObject({ fatal: true, status: 401 });
    const busy = new AnthropicAdapter("m", "k", fakeFetch(429, "slow down").fn);
    await expect(busy.complete({ system: "", user: "" })).rejects.toMatchObject({ fatal: false, status: 429 });
    await expect(new GeminiAdapter("m", "k", fakeFetch(200, { candidates: [] }).fn).complete({ system: "", user: "" })).rejects.toBeInstanceOf(LlmError);
  });

  it("createLlm picks provider/model from env and explains what is missing", () => {
    expect(createLlm(loadConfig({}))).toEqual({ error: "LLM_MODEL is not set in .env" });
    expect(createLlm(loadConfig({ LLM_MODEL: "m" }))).toEqual({ error: "GEMINI_API_KEY is not set in .env" });
    const g = createLlm(loadConfig({ LLM_MODEL: "m", GEMINI_API_KEY: "k" }));
    expect("llm" in g && g.llm.provider).toBe("gemini");
    const a = createLlm(loadConfig({ LLM_PROVIDER: "anthropic", LLM_MODEL: "m2", ANTHROPIC_API_KEY: "k" }));
    expect("llm" in a && [a.llm.provider, a.llm.model]).toEqual(["anthropic", "m2"]);
    expect(createLlm(loadConfig({ LLM_PROVIDER: "anthropic", LLM_MODEL: "m2" }))).toEqual({ error: "ANTHROPIC_API_KEY is not set in .env" });
  });

  describe("resilience", () => {
    const ok = { candidates: [{ content: { parts: [{ text: "hi" }] } }] };
    const quiet = { log: () => {}, sleep: async () => {} };

    function scripted(steps: Array<number | "hang">) {
      let i = 0;
      const urls: string[] = [];
      const fn: FetchLike = async (url, init) => {
        urls.push(url);
        const step = steps[Math.min(i++, steps.length - 1)]!;
        if (step === "hang") {
          return new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted"))));
        }
        return { ok: step < 300, status: step, text: async () => JSON.stringify(step < 300 ? ok : { error: "x" }) };
      };
      return { fn, urls };
    }

    it("retries 503 with exponential backoff, then succeeds", async () => {
      const f = scripted([503, 429, 200]);
      const sleeps: number[] = [];
      const a = new GeminiAdapter("m", "k", f.fn, { ...quiet, sleep: async (ms) => void sleeps.push(ms), baseDelayMs: 100 });
      await expect(a.complete({ system: "", user: "" })).resolves.toBe("hi");
      expect(f.urls).toHaveLength(3);
      expect(sleeps).toEqual([100, 200]);
    });

    it("gives up after 3 attempts with a retryable error; does not retry 401", async () => {
      const f = scripted([503]);
      await expect(new GeminiAdapter("m", "k", f.fn, quiet).complete({ system: "", user: "" })).rejects.toMatchObject({ status: 503, retryable: true });
      expect(f.urls).toHaveLength(3);
      const g = scripted([401]);
      await expect(new AnthropicAdapter("m", "k", g.fn, quiet).complete({ system: "", user: "" })).rejects.toMatchObject({ fatal: true });
      expect(g.urls).toHaveLength(1);
    });

    it("aborts a hung request after the timeout and retries it", async () => {
      const f = scripted(["hang", "hang", "hang"]);
      const a = new GeminiAdapter("m", "k", f.fn, { ...quiet, timeoutMs: 10 });
      await expect(a.complete({ system: "", user: "" })).rejects.toMatchObject({ retryable: true, message: expect.stringContaining("timed out") });
      expect(f.urls).toHaveLength(3);
    });

    it("falls back to LLM_FALLBACK_MODEL after the primary exhausts retries, and logs who answered", async () => {
      const f = scripted([503, 503, 503, 200]);
      const logs: string[] = [];
      const chain = ["primary", "backup"].map((m) => new GeminiAdapter(m, "k", f.fn, quiet));
      await expect(new FallbackLlm(chain, (m) => logs.push(m)).complete({ system: "", user: "" })).resolves.toBe("hi");
      expect(f.urls.map((u) => /models\/([^:]+)/.exec(u)![1])).toEqual(["primary", "primary", "primary", "backup"]);
      expect(logs.some((l) => l.includes("answered by gemini/backup (fallback)"))).toBe(true);
    });

    it("does not fall back on fatal errors; createLlm wires the fallback chain", async () => {
      const f = scripted([401, 200]);
      const chain = ["p", "b"].map((m) => new GeminiAdapter(m, "k", f.fn, quiet));
      await expect(new FallbackLlm(chain, () => {}).complete({ system: "", user: "" })).rejects.toMatchObject({ status: 401 });
      expect(f.urls).toHaveLength(1);
      const made = createLlm(loadConfig({ LLM_MODEL: "a", LLM_FALLBACK_MODEL: "b", GEMINI_API_KEY: "k" }));
      expect("llm" in made && made.llm).toBeInstanceOf(FallbackLlm);
      expect("llm" in made && (made.llm as any).chain.map((c: any) => c.model)).toEqual(["a", "b"]);
    });
  });
});
