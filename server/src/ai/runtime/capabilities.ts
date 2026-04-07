// ---------------------------------------------------------------------------
// AI Capabilities — runtime environment detection
// ---------------------------------------------------------------------------

import { execSync } from "node:child_process";
import pino from "pino";

const logger = pino({ name: "ai-capabilities" });

function commandExists(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export interface AICapabilities {
  openai: boolean;
  anthropic: boolean;
  mistral: boolean;
  openclaw: boolean;
  claude_code: boolean;
  codex: boolean;
  cursor: boolean;
  bash: boolean;
  http: boolean;
}

let _cached: AICapabilities | null = null;

/** Detect which AI engines are available based on env vars + CLI tools */
export function detectCapabilities(): AICapabilities {
  if (_cached) return _cached;

  _cached = {
    openai: !!process.env.OPENAI_API_KEY,
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    mistral: !!process.env.MISTRAL_API_KEY,
    openclaw: !!(process.env.OPENCLAW_URL || process.env.OPENCLAW_API_URL || process.env.OPENCLAW_API_KEY),
    claude_code: commandExists("claude-code") || commandExists("claude"),
    codex: commandExists("codex") || !!process.env.OPENAI_API_KEY,
    cursor: commandExists("cursor"),
    bash: true,  // always available
    http: true,  // always available
  };

  const enabled = Object.entries(_cached)
    .filter(([, v]) => v)
    .map(([k]) => k);

  logger.info({ enabled }, "AI capabilities detected");

  return _cached;
}

/** Force re-detection (useful after env changes) */
export function resetCapabilities(): void {
  _cached = null;
}

/** Check if a specific engine is available */
export function isEngineAvailable(engine: string): boolean {
  const caps = detectCapabilities();
  return (caps as unknown as Record<string, boolean>)[engine] ?? false;
}
