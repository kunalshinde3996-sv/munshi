export interface LlmRequest {
  system: string;
  user: string;
  /** Ask the provider for JSON output where it supports a JSON mode. */
  json?: boolean;
  maxTokens?: number;
}

/**
 * Text-in / text-out LLM adapter. Deliberately has NO tool-calling surface:
 * the Quarantined Extractor must be structurally unable to call tools.
 */
export interface LlmAdapter {
  readonly provider: string;
  readonly model: string;
  complete(req: LlmRequest): Promise<string>;
}

/**
 * `fatal` errors (bad key, unknown model) abort a scan instead of failing one email.
 * `retryable` errors (429 / 503 / timeout) are retried with backoff, then handed to the fallback model.
 */
export class LlmError extends Error {
  constructor(message: string, readonly fatal = false, readonly status?: number, readonly retryable = false) {
    super(message);
  }
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export interface NetOptions {
  /** Per-attempt request timeout (AbortController). Default 30s. */
  timeoutMs: number;
  /** Total attempts per model on 429/503/timeout. Default 3. */
  attempts: number;
  /** Backoff = baseDelayMs * 2^(attempt-1). Default 500ms. */
  baseDelayMs: number;
  sleep: (ms: number) => Promise<void>;
  log: (msg: string) => void;
}

export const defaultNet: NetOptions = {
  timeoutMs: 30_000,
  attempts: 3,
  baseDelayMs: 500,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  log: (m) => console.log(m),
};

const RETRYABLE_STATUS = new Set([429, 503]);

async function postOnce(fetchFn: FetchLike, url: string, headers: Record<string, string>, body: unknown, timeoutMs: number) {
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, timeoutMs);
  try {
    let res;
    let text: string;
    try {
      res = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      text = await res.text();
    } catch (e) {
      if (timedOut) throw new LlmError(`LLM request timed out after ${timeoutMs}ms`, false, undefined, true);
      throw new LlmError(`Network error calling LLM: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) {
      const fatal = [400, 401, 403, 404].includes(res.status);
      throw new LlmError(`LLM HTTP ${res.status}: ${text.slice(0, 300)}`, fatal, res.status, RETRYABLE_STATUS.has(res.status));
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new LlmError("LLM returned a non-JSON HTTP body");
    }
  } finally {
    clearTimeout(timer);
  }
}

/** POST JSON with a timeout, retrying retryable failures with exponential backoff. `label` is for logs only. */
export async function postJson(
  fetchFn: FetchLike,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  net: Partial<NetOptions> = {},
  label = "llm",
) {
  const o = { ...defaultNet, ...net };
  for (let attempt = 1; ; attempt++) {
    try {
      return await postOnce(fetchFn, url, headers, body, o.timeoutMs);
    } catch (e) {
      if (!(e instanceof LlmError) || !e.retryable || attempt >= o.attempts) throw e;
      const delay = o.baseDelayMs * 2 ** (attempt - 1);
      o.log(`[llm] ${label}: attempt ${attempt}/${o.attempts} failed (${e.status ?? "timeout"}); retrying in ${delay}ms`);
      await o.sleep(delay);
    }
  }
}

/** Primary model first; if it is still failing with a retryable error after all retries, try the fallback model. */
async function withFallback<T extends { provider: string; model: string }, R>(
  candidates: T[],
  call: (c: T) => Promise<R>,
  log: (msg: string) => void,
): Promise<R> {
  let lastErr: unknown;
  for (const [i, c] of candidates.entries()) {
    try {
      const out = await call(c);
      log(`[llm] answered by ${c.provider}/${c.model}${i > 0 ? " (fallback)" : ""}`);
      return out;
    } catch (e) {
      lastErr = e;
      const next = candidates[i + 1];
      if (!next || !(e instanceof LlmError) || !e.retryable) throw e;
      log(`[llm] ${c.provider}/${c.model} unavailable after retries (${e.status ?? "timeout"}); falling back to ${next.model}`);
    }
  }
  throw lastErr;
}

export class FallbackLlm implements LlmAdapter {
  constructor(private readonly chain: LlmAdapter[], private readonly log: (m: string) => void = defaultNet.log) {}
  get provider() {
    return this.chain[0]!.provider;
  }
  get model() {
    return this.chain[0]!.model;
  }
  complete(req: LlmRequest) {
    return withFallback(this.chain, (a) => a.complete(req), this.log);
  }
}

export { withFallback };
