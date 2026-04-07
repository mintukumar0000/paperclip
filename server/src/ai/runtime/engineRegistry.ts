// ---------------------------------------------------------------------------
// Engine Registry — central catalogue of all AI engines
// ---------------------------------------------------------------------------

import { detectCapabilities } from "./capabilities.js";
import pino from "pino";

const logger = pino({ name: "engine-registry" });

export type EngineType = "llm" | "runtime";

export interface EngineEntry {
  name: string;
  type: EngineType;
  enabled: boolean;
  description: string;
}

/** Build the engine registry from detected capabilities */
export function getEngineRegistry(): Record<string, EngineEntry> {
  const caps = detectCapabilities();

  return {
    openai: {
      name: "openai",
      type: "llm",
      enabled: caps.openai,
      description: "OpenAI GPT models (GPT-4o, GPT-4o-mini)",
    },
    anthropic: {
      name: "anthropic",
      type: "llm",
      enabled: caps.anthropic,
      description: "Anthropic Claude models",
    },
    mistral: {
      name: "mistral",
      type: "llm",
      enabled: caps.mistral,
      description: "Mistral AI models",
    },
    openclaw: {
      name: "openclaw",
      type: "runtime",
      enabled: caps.openclaw,
      description: "OpenClaw autonomous agent platform",
    },
    claude_code: {
      name: "claude_code",
      type: "runtime",
      enabled: caps.claude_code,
      description: "Claude Code CLI autonomous coding agent",
    },
    codex: {
      name: "codex",
      type: "runtime",
      enabled: caps.codex,
      description: "OpenAI Codex CLI for code generation",
    },
    cursor: {
      name: "cursor",
      type: "runtime",
      enabled: caps.cursor,
      description: "Cursor AI editor runtime",
    },
    bash: {
      name: "bash",
      type: "runtime",
      enabled: caps.bash,
      description: "Local Bash shell execution",
    },
    http: {
      name: "http",
      type: "runtime",
      enabled: caps.http,
      description: "HTTP webhook-based execution",
    },
  };
}

/** Get only enabled engines */
export function getEnabledEngines(): EngineEntry[] {
  const registry = getEngineRegistry();
  return Object.values(registry).filter((e) => e.enabled);
}

/** Get enabled engines grouped by type */
export function getEnabledEnginesByType(): { llm: EngineEntry[]; runtime: EngineEntry[] } {
  const enabled = getEnabledEngines();
  return {
    llm: enabled.filter((e) => e.type === "llm"),
    runtime: enabled.filter((e) => e.type === "runtime"),
  };
}

/** Resolve an engine from the registry, ensuring it exists and is enabled */
export function resolveRegistryEngine(engine: string): EngineEntry {
  const registry = getEngineRegistry();
  const entry = registry[engine];

  if (!entry) {
    throw new Error(`Unknown engine: ${engine}. Available: ${Object.keys(registry).join(", ")}`);
  }

  if (!entry.enabled) {
    throw new Error(
      `Engine '${engine}' is not available. Check environment configuration.`,
    );
  }

  return entry;
}
