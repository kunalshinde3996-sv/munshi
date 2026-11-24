import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { AnthropicAdapter, createLlm, FallbackLlm, GeminiAdapter, LlmError, Pacer, parseRetryDelayMs, type FetchLike } from "../src/llm/index.js";

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
      const f = scripted([503, 503, 200]);
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

    it("retries transient network errors (fetch failed, ECONNRESET, ETIMEDOUT) but not other network errors", async () => {
      const mk = (errs: Error[]) => {
        let i = 0;
        const fn: FetchLike = async () => {
          const e = errs[i++];
          if (e) throw e;
          return { ok: true, status: 200, text: async () => JSON.stringify(ok) };
        };
        return { fn, count: () => i };
      };
      const withCause = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("boom"), { code }) });
      const f = mk([withCause("ECONNRESET"), new Error("read ETIMEDOUT"), new TypeError("fetch failed")]);
      await expect(new GeminiAdapter("m", "k", f.fn, quiet).complete({ system: "", user: "" })).rejects.toMatchObject({ retryable: true });
      expect(f.count()).toBe(3);
      const g = mk([withCause("ECONNRESET")]);
      await expect(new GeminiAdapter("m", "k", g.fn, quiet).complete({ system: "", user: "" })).resolves.toBe("hi");
      const h = mk([new Error("invalid URL")]);
      await expect(new GeminiAdapter("m", "k", h.fn, quiet).complete({ system: "", user: "" })).rejects.toMatchObject({ retryable: false });
      expect(h.count()).toBe(1);
    });

    const quota429 = (delay: string) =>
      JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "You exceeded your current quota", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: delay }] } });
    function quotaThen(bodies: Array<string | null>) {
      let i = 0;
      const urls: string[] = [];
      const fn: FetchLike = async (url) => {
        urls.push(url);
        const b = bodies[Math.min(i++, bodies.length - 1)];
        if (b === null) return { ok: true, status: 200, text: async () => JSON.stringify(ok) };
        return { ok: false, status: 429, text: async () => b as string };
      };
      return { fn, urls };
    }

    it("parses retryDelay from Gemini 429 bodies and Retry-After headers", () => {
      expect(parseRetryDelayMs(quota429("34s"))).toBe(34_000);
      expect(parseRetryDelayMs("Please retry in 2.5s.")).toBe(2_500);
      expect(parseRetryDelayMs("whatever", "7")).toBe(7_000);
      expect(parseRetryDelayMs("no hint")).toBeUndefined();
    });

    it("a 429 is never retried in place (no storm): one request, quota error carrying retryDelay", async () => {
      const f = quotaThen([quota429("12s")]);
      await expect(new GeminiAdapter("m", "k", f.fn, quiet).complete({ system: "", user: "" })).rejects.toMatchObject({ status: 429, quota: true, retryAfterMs: 12_000 });
      expect(f.urls).toHaveLength(1);
    });

    it("on quota 429: waits the server retryDelay, then falls back exactly once", async () => {
      const f = quotaThen([quota429("12s"), null]);
      const sleeps: number[] = [];
      const logs: string[] = [];
      const chain = ["primary", "backup"].map((m) => new GeminiAdapter(m, "k", f.fn, quiet));
      const llm = new FallbackLlm(chain, { log: (m) => logs.push(m), sleep: async (ms) => void sleeps.push(ms) });
      await expect(llm.complete({ system: "", user: "" })).resolves.toBe("hi");
      expect(sleeps).toEqual([12_000]);
      expect(f.urls.map((u) => /models\/([^:]+)/.exec(u)![1])).toEqual(["primary", "backup"]);
      expect(logs.join(" | ")).toContain("waiting 12s then falling back");
      // fallback also over quota -> gives up (no third attempt, no loop)
      const g = quotaThen([quota429("5s")]);
      const chain2 = ["p", "b"].map((m) => new GeminiAdapter(m, "k", g.fn, quiet));
      await expect(new FallbackLlm(chain2, { log: () => {}, sleep: async () => {} }).complete({ system: "", user: "" })).rejects.toMatchObject({ quota: true });
      expect(g.urls).toHaveLength(2);
    });

    it("does not sit through a long retryDelay (e.g. daily quota); single model retries once after the wait", async () => {
      const f = quotaThen([quota429("3600s"), null]);
      const sleeps: number[] = [];
      const chain = ["p", "b"].map((m) => new GeminiAdapter(m, "k", f.fn, quiet));
      await new FallbackLlm(chain, { log: () => {}, sleep: async (ms) => void sleeps.push(ms) }).complete({ system: "", user: "" });
      expect(sleeps).toEqual([]);
      const g = quotaThen([quota429("4s"), null]);
      const sl: number[] = [];
      const single = new FallbackLlm([new GeminiAdapter("only", "k", g.fn, quiet)], { log: () => {}, sleep: async (ms) => void sl.push(ms) });
      await expect(single.complete({ system: "", user: "" })).resolves.toBe("hi");
      expect(sl).toEqual([4_000]);
      expect(g.urls).toHaveLength(2);
    });

    it("Pacer spaces requests 60/rpm seconds apart (and is off at rpm 0)", async () => {
      let t = 0;
      const slept: number[] = [];
      const p = new Pacer(8, () => t, async (ms) => { slept.push(ms); t += ms; });
      await p.wait();
      await p.wait();
      await p.wait();
      expect(slept).toEqual([7_500, 7_500]);
      const off = new Pacer(0, () => t, async () => { throw new Error("should not sleep"); });
      await off.wait();
      await off.wait();
    });

    it("the pacer is awaited before every HTTP attempt", async () => {
      const f = scripted([503, 200]);
      let paced = 0;
      await new GeminiAdapter("m", "k", f.fn, { ...quiet, pace: async () => void paced++ }).complete({ system: "", user: "" });
      expect(paced).toBe(2);
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
      await expect(new FallbackLlm(chain, { log: (m) => logs.push(m), sleep: async () => {} }).complete({ system: "", user: "" })).resolves.toBe("hi");
      expect(f.urls.map((u) => /models\/([^:]+)/.exec(u)![1])).toEqual(["primary", "primary", "primary", "backup"]);
      expect(logs.some((l) => l.includes("answered by gemini/backup (fallback)"))).toBe(true);
    });

    it("does not fall back on fatal errors; createLlm wires the fallback chain", async () => {
      const f = scripted([401, 200]);
      const chain = ["p", "b"].map((m) => new GeminiAdapter(m, "k", f.fn, quiet));
      await expect(new FallbackLlm(chain, { log: () => {}, sleep: async () => {} }).complete({ system: "", user: "" })).rejects.toMatchObject({ status: 401 });
      expect(f.urls).toHaveLength(1);
      const made = createLlm(loadConfig({ LLM_MODEL: "a", LLM_FALLBACK_MODEL: "b", GEMINI_API_KEY: "k" }));
      expect("llm" in made && made.llm).toBeInstanceOf(FallbackLlm);
      expect("llm" in made && (made.llm as any).chain.map((c: any) => c.model)).toEqual(["a", "b"]);
    });
  });
});
