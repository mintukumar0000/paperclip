import pino from "pino";

const logger = pino({ name: "ai-token-tracker" });

interface TokenUsageEntry {
  runId: string;
  agentId: string;
  companyId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
  timestamp: Date;
}

/** In-memory rolling window for real-time token tracking */
const recentUsage: TokenUsageEntry[] = [];
const MAX_ENTRIES = 1000;

/**
 * Record token usage from an LLM call.
 * This supplements the existing costEvents table with in-memory
 * real-time tracking for dashboards and rate monitoring.
 */
export function trackTokenUsage(entry: TokenUsageEntry): void {
  recentUsage.push(entry);
  if (recentUsage.length > MAX_ENTRIES) {
    recentUsage.splice(0, recentUsage.length - MAX_ENTRIES);
  }

  logger.info(
    {
      runId: entry.runId,
      provider: entry.provider,
      model: entry.model,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      costUsd: entry.costUsd,
    },
    "Token usage tracked",
  );
}

/** Get total usage for a company in the last N minutes */
export function getRecentUsage(
  companyId: string,
  windowMinutes = 60,
): {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  callCount: number;
} {
  const cutoff = new Date(Date.now() - windowMinutes * 60 * 1000);
  const entries = recentUsage.filter(
    (e) => e.companyId === companyId && e.timestamp >= cutoff,
  );

  return {
    totalInputTokens: entries.reduce((sum, e) => sum + e.inputTokens, 0),
    totalOutputTokens: entries.reduce((sum, e) => sum + e.outputTokens, 0),
    totalCostUsd: entries.reduce((sum, e) => sum + (e.costUsd ?? 0), 0),
    callCount: entries.length,
  };
}

/** Get usage breakdown by provider */
export function getUsageByProvider(
  companyId: string,
  windowMinutes = 60,
): Record<string, { inputTokens: number; outputTokens: number; calls: number }> {
  const cutoff = new Date(Date.now() - windowMinutes * 60 * 1000);
  const entries = recentUsage.filter(
    (e) => e.companyId === companyId && e.timestamp >= cutoff,
  );

  const byProvider: Record<string, { inputTokens: number; outputTokens: number; calls: number }> = {};
  for (const e of entries) {
    if (!byProvider[e.provider]) {
      byProvider[e.provider] = { inputTokens: 0, outputTokens: 0, calls: 0 };
    }
    byProvider[e.provider].inputTokens += e.inputTokens;
    byProvider[e.provider].outputTokens += e.outputTokens;
    byProvider[e.provider].calls++;
  }

  return byProvider;
}

/** Clear tracked usage (for testing) */
export function clearTrackedUsage(): void {
  recentUsage.length = 0;
}
