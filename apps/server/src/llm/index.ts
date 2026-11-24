import type { Config } from "../config.js";
import { AnthropicAdapter } from "./anthropic.js";
import { GeminiAdapter } from "./gemini.js";
import { FallbackLlm, sharedPacer, type LlmAdapter, type NetOptions } from "./types.js";

export * from "./types.js";
export { AnthropicAdapter, GeminiAdapter };

/** [LLM_MODEL, LLM_FALLBACK_MODEL?] — the fallback is ignored when unset or identical to the primary. */
function modelChain(config: Config): string[] {
  const fb = config.LLM_FALLBACK_MODEL;
  return fb && fb !== config.LLM_MODEL ? [config.LLM_MODEL!, fb] : [config.LLM_MODEL!];
}

/** Shared request pacing (LLM_RPM, default 8; 0 = off) for every adapter built from this config. */
function net(config: Config): Partial<NetOptions> {
  return { pace: sharedPacer(config.LLM_RPM).wait };
}

/** Returns an adapter, or a human-readable reason why none can be built. Nothing is hardcoded. */
export function createLlm(config: Config): { llm: LlmAdapter } | { error: string } {
  if (!config.LLM_MODEL) return { error: "LLM_MODEL is not set in .env" };
  if (config.LLM_PROVIDER === "gemini") {
    if (!config.GEMINI_API_KEY) return { error: "GEMINI_API_KEY is not set in .env" };
    const key = config.GEMINI_API_KEY;
    return { llm: new FallbackLlm(modelChain(config).map((m) => new GeminiAdapter(m, key, undefined, net(config)))) };
  }
  if (!config.ANTHROPIC_API_KEY) return { error: "ANTHROPIC_API_KEY is not set in .env" };
  const key = config.ANTHROPIC_API_KEY;
  return { llm: new FallbackLlm(modelChain(config).map((m) => new AnthropicAdapter(m, key, undefined, net(config)))) };
}

import { AnthropicAgentLlm, FallbackAgentLlm, GeminiAgentLlm, type AgentLlm } from "./agent.js";
export * from "./agent.js";

/** Tool-calling adapter for the Agent runtime (same env config as createLlm). */
export function createAgentLlm(config: Config): { agent: AgentLlm } | { error: string } {
  if (!config.LLM_MODEL) return { error: "LLM_MODEL is not set in .env" };
  if (config.LLM_PROVIDER === "gemini") {
    if (!config.GEMINI_API_KEY) return { error: "GEMINI_API_KEY is not set in .env" };
    const key = config.GEMINI_API_KEY;
    return { agent: new FallbackAgentLlm(modelChain(config).map((m) => new GeminiAgentLlm(m, key, undefined, net(config)))) };
  }
  if (!config.ANTHROPIC_API_KEY) return { error: "ANTHROPIC_API_KEY is not set in .env" };
  const key = config.ANTHROPIC_API_KEY;
  return { agent: new FallbackAgentLlm(modelChain(config).map((m) => new AnthropicAgentLlm(m, key, undefined, net(config)))) };
}
