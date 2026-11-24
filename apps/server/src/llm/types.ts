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
 * `retryable` errors (503 / timeout / network) are retried with backoff, then handed to the fallback model.
 * `quota` errors (429) are NOT retried in place: the caller waits `retryAfterMs` (if sane) and moves to the fallback model once.
 */
export class LlmError extends Error {
  constructor(
    message: string,
    readonly fatal = false,
    readonly status?: number,
    readonly retryable = false,
    readonly quota = false,
    /** Server-provided wait (Gemini retryDelay / "retry in Ns" / Retry-After header). */
    readonly retryAfterMs?: number,
  ) {
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
  headers?: { get(name: string): string | null };
}>;

export interface NetOptions {
  /** Per-attempt request timeout (AbortController). Default 30s. */
  timeoutMs: number;
  /** Total attempts per model on 503/timeout/network. Default 3. */
  attempts: number;
  /** Backoff = baseDelayMs * 2^(attempt-1). Default 500ms. */
  baseDelayMs: number;
  sleep: (ms: number) => Promise<void>;
  log: (msg: string) => void;
  /** Awaited before every HTTP attempt (global requests-per-minute pacing). */
  pace?: () => Promise<void>;
}

export const defaultNet: NetOptions = {
  timeoutMs: 30_000,
  attempts: 3,
  baseDelayMs: 500,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  log: (m) => console.log(m),
};

/** Longest 429 wait we sit through. A longer hint (e.g. a daily quota) is not waited out: we go straight to the fallback. */
export const MAX_QUOTA_WAIT_MS = 60_000;

/** Spaces LLM requests at least 60/rpm seconds apart. rpm <= 0 disables pacing. */
export class Pacer {
  private next = 0;
  constructor(
    readonly rpm: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = defaultNet.sleep,
  ) {}
  readonly wait = async (): Promise<void> => {
    if (this.rpm <= 0) return;
    const t = this.now();
    const slot = Math.max(t, this.next);
    this.next = slot + 60_000 / this.rpm;
    if (slot > t) await this.sleep(slot - t);
  };
}

let shared: Pacer | undefined;
/** One pacer per process, so the extractor and the agent share the same request budget. */
export function sharedPacer(rpm: number): Pacer {
  if (!shared || shared.rpm !== rpm) shared = new Pacer(rpm);
  return shared;
}

const RETRYABLE_STATUS = new Set([503]);
const TRANSIENT_NET = /fetch failed|ECONNRESET|ETIMEDOUT/;

/** Node's fetch throws `TypeError: fetch failed` with the socket error (ECONNRESET, ETIMEDOUT, ...) in `cause`. */
export function isTransientNetworkError(e: unknown): boolean {
  const parts: string[] = [];
  for (let x: unknown = e, depth = 0; x && depth < 4; x = (x as { cause?: unknown }).cause, depth++) {
    const err = x as { message?: unknown; code?: unknown };
    parts.push(String(err.message ?? ""), String(err.code ?? ""));
  }
  return TRANSIENT_NET.test(parts.join(" "));
}

/** Extracts the server's suggested wait from a 429 (Retry-After header, `"retryDelay": "34s"`, or "retry in 34.5s"). */
export function parseRetryDelayMs(body: string, retryAfterHeader?: string | null): number | undefined {
  const header = retryAfterHeader ? Number(retryAfterHeader) : Number.NaN;
  if (Number.isFinite(header) && header >= 0) return Math.ceil(header * 1000);
  const m = /"retryDelay"\s*:\s*"([\d.]+)s"/.exec(body) ?? /retry in ([\d.]+)\s*s/i.exec(body);
  return m ? Math.ceil(Number(m[1]) * 1000) : undefined;
}

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
      throw new LlmError(`Network error calling LLM: ${e instanceof Error ? e.message : String(e)}`, false, undefined, isTransientNetworkError(e));
    }
    if (!res.ok) {
      const fatal = [400, 401, 403, 404].includes(res.status);
      const quota = res.status === 429;
      const wait = quota ? parseRetryDelayMs(text, res.headers?.get("retry-after")) : undefined;
      throw new LlmError(`LLM HTTP ${res.status}: ${text.slice(0, 300)}`, fatal, res.status, RETRYABLE_STATUS.has(res.status), quota, wait);
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

/**
 * POST JSON with pacing and a timeout. 503/timeout/network failures are retried with exponential backoff.
 * A 429 is never retried here (no retry storms): it surfaces as a `quota` error for `withFallback` to handle.
 */
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
      await o.pace?.();
      return await postOnce(fetchFn, url, headers, body, o.timeoutMs);
    } catch (e) {
      if (!(e instanceof LlmError) || !e.retryable || attempt >= o.attempts) throw e;
      const delay = o.baseDelayMs * 2 ** (attempt - 1);
      o.log(`[llm] ${label}: attempt ${attempt}/${o.attempts} failed (${e.status ?? "timeout/network"}); retrying in ${delay}ms`);
      await o.sleep(delay);
    }
  }
}

export interface FallbackOptions {
  log: (msg: string) => void;
  sleep: (ms: number) => Promise<void>;
}

/**
 * Primary model first. After its own retries, a retryable failure or a 429 quota error moves to the fallback ONCE.
 * On a 429 the server's retryDelay is honoured first (when <= MAX_QUOTA_WAIT_MS). With no fallback configured,
 * a quota error earns one more try on the same model after that wait; transient errors do not.
 */
export async function withFallback<T extends { provider: string; model: string }, R>(
  candidates: T[],
  call: (c: T) => Promise<R>,
  opts: Partial<FallbackOptions> = {},
): Promise<R> {
  const { log, sleep } = { log: defaultNet.log, sleep: defaultNet.sleep, ...opts };
  const single = candidates.length === 1;
  const order = single ? [candidates[0]!, candidates[0]!] : candidates;
  let lastErr: unknown;
  for (const [i, c] of order.entries()) {
    try {
      const out = await call(c);
      log(`[llm] answered by ${c.provider}/${c.model}${i > 0 && !single ? " (fallback)" : ""}`);
      return out;
    } catch (e) {
      lastErr = e;
      const next = order[i + 1];
      if (!next || !(e instanceof LlmError) || !(e.retryable || e.quota)) throw e;
      if (single && !e.quota) throw e;
      if (e.quota) {
        const hint = e.retryAfterMs;
        const wait = hint !== undefined && hint <= MAX_QUOTA_WAIT_MS ? hint : 0;
        const hintText = hint !== undefined ? `${Math.round(hint / 1000)}s` : "unknown";
        const waitText = wait ? `waiting ${Math.round(wait / 1000)}s then ` : "";
        log(`[llm] ${c.provider}/${c.model} quota 429 (server retryDelay ${hintText}); ${waitText}${single ? "retrying once" : `falling back to ${next.model}`}`);
        if (wait) await sleep(wait);
      } else {
        log(`[llm] ${c.provider}/${c.model} unavailable after retries (${e.status ?? "timeout/network"}); falling back to ${next.model}`);
      }
    }
  }
  throw lastErr;
}

export class FallbackLlm implements LlmAdapter {
  constructor(private readonly chain: LlmAdapter[], private readonly opts: Partial<FallbackOptions> = {}) {}
  get provider() {
    return this.chain[0]!.provider;
  }
  get model() {
    return this.chain[0]!.model;
  }
  complete(req: LlmRequest) {
    return withFallback(this.chain, (a) => a.complete(req), this.opts);
  }
}
