import type { Config } from "../config.js";
import { AnthropicAdapter } from "./anthropic.js";
import { GeminiAdapter } from "./gemini.js";
import type { LlmAdapter } from "./types.js";

export * from "./types.js";
export { AnthropicAdapter, GeminiAdapter };

/** Returns an adapter, or a human-readable reason why none can be built. Nothing is hardcoded. */
export function createLlm(config: Config): { llm: LlmAdapter } | { error: string } {
  if (!config.LLM_MODEL) return { error: "LLM_MODEL is not set in .env" };
  if (config.LLM_PROVIDER === "gemini") {
    if (!config.GEMINI_API_KEY) return { error: "GEMINI_API_KEY is not set in .env" };
    return { llm: new GeminiAdapter(config.LLM_MODEL, config.GEMINI_API_KEY) };
  }
  if (!config.ANTHROPIC_API_KEY) return { error: "ANTHROPIC_API_KEY is not set in .env" };
  return { llm: new AnthropicAdapter(config.LLM_MODEL, config.ANTHROPIC_API_KEY) };
}

import { AnthropicAgentLlm, GeminiAgentLlm, type AgentLlm } from "./agent.js";
export * from "./agent.js";

/** Tool-calling adapter for the Agent runtime (same env config as createLlm). */
export function createAgentLlm(config: Config): { agent: AgentLlm } | { error: string } {
  if (!config.LLM_MODEL) return { error: "LLM_MODEL is not set in .env" };
  if (config.LLM_PROVIDER === "gemini") {
    if (!config.GEMINI_API_KEY) return { error: "GEMINI_API_KEY is not set in .env" };
    return { agent: new GeminiAgentLlm(config.LLM_MODEL, config.GEMINI_API_KEY) };
  }
  if (!config.ANTHROPIC_API_KEY) return { error: "ANTHROPIC_API_KEY is not set in .env" };
  return { agent: new AnthropicAgentLlm(config.LLM_MODEL, config.ANTHROPIC_API_KEY) };
}
