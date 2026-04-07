import type { LLMAdapter } from "../types.js";
import { OpenAIAdapter } from "../adapters/llm/openaiAdapter.js";
import { AnthropicAdapter } from "../adapters/llm/anthropicAdapter.js";
import { MistralAdapter } from "../adapters/llm/mistralAdapter.js";
import pino from "pino";

const logger = pino({ name: "ai-llm-router" });

const adapterCache = new Map<string, LLMAdapter>();

function getOrCreate(key: string, factory: () => LLMAdapter): LLMAdapter {
  let adapter = adapterCache.get(key);
  if (!adapter) {
    adapter = factory();
    adapterCache.set(key, adapter);
  }
  return adapter;
}

/**
 * Resolve the LLM adapter based on provider name.
 * Defaults to OpenAI if no match found.
 */
export function getLLMAdapter(provider: string): LLMAdapter {
  switch (provider) {
    case "openai":
      return getOrCreate("openai", () => new OpenAIAdapter());
    case "anthropic":
      return getOrCreate("anthropic", () => new AnthropicAdapter());
    case "mistral":
      return getOrCreate("mistral", () => new MistralAdapter());
    default:
      logger.warn({ provider }, "Unknown LLM provider, falling back to OpenAI");
      return getOrCreate("openai", () => new OpenAIAdapter());
  }
}

/** List all available LLM provider names */
export function listLLMProviders(): string[] {
  return ["openai", "anthropic", "mistral"];
}
