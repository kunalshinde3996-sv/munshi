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

/** `fatal` errors (bad key, unknown model) abort a scan instead of failing one email. */
export class LlmError extends Error {
  constructor(message: string, readonly fatal = false, readonly status?: number) {
    super(message);
  }
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export async function postJson(fetchFn: FetchLike, url: string, headers: Record<string, string>, body: unknown) {
  let res;
  try {
    res = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new LlmError(`Network error calling LLM: ${e instanceof Error ? e.message : String(e)}`);
  }
  const text = await res.text();
  if (!res.ok) {
    const fatal = [400, 401, 403, 404].includes(res.status);
    throw new LlmError(`LLM HTTP ${res.status}: ${text.slice(0, 300)}`, fatal, res.status);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new LlmError("LLM returned a non-JSON HTTP body");
  }
}
