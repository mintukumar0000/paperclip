import type { LLMAdapter, RuntimeAdapter, AIExecutionContext } from "../types.js";
import { getLLMAdapter } from "./llmRouter.js";
import { resolveRegistryEngine, getEnabledEngines, getEnabledEnginesByType, type EngineEntry } from "../runtime/engineRegistry.js";
import { OpenClawRuntimeAdapter } from "../adapters/runtime/openclawAdapter.js";
import { ClaudeCodeRuntimeAdapter } from "../adapters/runtime/claudeCodeAdapter.js";
import { CodexRuntimeAdapter } from "../adapters/runtime/codexAdapter.js";
import { CursorRuntimeAdapter } from "../adapters/runtime/cursorAdapter.js";
import { BashRuntimeAdapter } from "../adapters/runtime/bashAdapter.js";
import { HttpRuntimeAdapter } from "../adapters/runtime/httpAdapter.js";
import pino from "pino";

const logger = pino({ name: "ai-adapter-router" });

/** Runtime type → which execution path to use */
export type ExecutionEngine =
  | { kind: "llm"; adapter: LLMAdapter }
  | { kind: "runtime"; adapter: RuntimeAdapter };

const runtimeAdapters: Record<string, () => RuntimeAdapter> = {
  openclaw: () => new OpenClawRuntimeAdapter(),
  claude_code: () => new ClaudeCodeRuntimeAdapter(),
  codex: () => new CodexRuntimeAdapter(),
  cursor: () => new CursorRuntimeAdapter(),
  bash: () => new BashRuntimeAdapter(),
  http: () => new HttpRuntimeAdapter(),
};

const LLM_PROVIDERS = new Set(["openai", "anthropic", "mistral"]);

/**
 * Select execution engine for an agent based on its runtime field.
 * Validates the engine is available via the engine registry.
 * LLM providers route to direct LLM calls, everything else goes to runtime adapters.
 */
export function getExecutionEngine(agent: AIExecutionContext["agent"]): ExecutionEngine {
  const runtime = agent.runtime ?? "openai";

  // Validate through engine registry (throws if unknown or disabled)
  const entry = resolveRegistryEngine(runtime);

  if (entry.type === "llm") {
    logger.info({ agentId: agent.id, runtime, kind: "llm" }, "Routing to LLM adapter");
    return { kind: "llm", adapter: getLLMAdapter(runtime) };
  }

  const runtimeFactory = runtimeAdapters[runtime];
  if (!runtimeFactory) {
    throw new Error(`No runtime adapter implemented for: ${runtime}`);
  }

  logger.info({ agentId: agent.id, runtime, kind: "runtime" }, "Routing to runtime adapter");
  return { kind: "runtime", adapter: runtimeFactory() };
}

/**
 * Resolve an engine string to an LLM or runtime adapter.
 * Rejects disabled engines.
 */
export function resolveEngine(engine: string): ExecutionEngine {
  const entry = resolveRegistryEngine(engine);

  if (entry.type === "llm") {
    return { kind: "llm", adapter: getLLMAdapter(engine) };
  }

  const factory = runtimeAdapters[engine];
  if (!factory) {
    throw new Error(`No runtime adapter for: ${engine}`);
  }
  return { kind: "runtime", adapter: factory() };
}

/** List all known execution engine types (enabled + disabled) */
export function listExecutionEngines(): string[] {
  return [
    "openai", "anthropic", "mistral",
    "openclaw", "claude_code", "codex", "cursor",
    "bash", "http",
  ];
}

/** List only engines that are currently available */
export function listAvailableEngines(): EngineEntry[] {
  return getEnabledEngines();
}

/** List available engines grouped as brains (LLM) and hands (runtime) */
export function listEnginesByCategory(): { brains: EngineEntry[]; hands: EngineEntry[] } {
  const { llm, runtime } = getEnabledEnginesByType();
  return { brains: llm, hands: runtime };
}
