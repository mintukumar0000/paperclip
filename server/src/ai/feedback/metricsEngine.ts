import type { Db } from "@paperclipai/db";
import { and, desc, eq, gte } from "@paperclipai/db";
import { systemMetrics } from "@paperclipai/db";
import { eventBus } from "../../events/eventBus.js";
import pino from "pino";

const logger = pino({ name: "system-metrics-engine" });

export type MetricSourceType =
  | "task_execution"
  | "simulation_run"
  | "tool_action"
  | "strategy_outcome";

export interface SystemMetricInput {
  companyId: string;
  sourceType: MetricSourceType;
  sourceId?: string;
  traffic?: number;
  conversions?: number;
  revenueCents?: number;
  taskSuccessRate?: number;
  costPerActionCents?: number;
  bounceRatePercent?: number;
  metadata?: Record<string, unknown>;
  recordedAt?: Date;
}

export interface SystemMetricSnapshot {
  traffic: number;
  conversions: number;
  revenue: number;
  total_revenue: number;
  payment_conversions: number;
  payment_conversion_rate: number;
  revenue_per_user: number;
  revenue_per_visit: number;
  task_success_rate: number;
  cost_per_action: number;
  conversion_rate: number;
  bounce_rate: number;
  sample_count: number;
  window_minutes: number;
}

function clampNonNegativeInt(value: number | undefined): number {
  if (value == null || Number.isNaN(value)) return 0;
  return Math.max(0, Math.round(value));
}

function clampRate(value: number | undefined): number {
  if (value == null || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function clampPercent(value: number | undefined): number {
  if (value == null || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function extractBounceRatePercent(metadata: unknown): number | null {
  if (!metadata || typeof metadata !== "object") return null;
  const bag = metadata as Record<string, unknown>;
  const rawCandidates = [bag.bounceRatePercent, bag.bounceRate, bag.bounce_rate];
  for (const candidate of rawCandidates) {
    const parsed = toFiniteNumber(candidate);
    if (parsed != null) return clampPercent(parsed);
  }
  return null;
}

/**
 * Persist one metric sample emitted by runtime behavior.
 */
export async function recordSystemMetric(db: Db, input: SystemMetricInput): Promise<void> {
  const traffic = clampNonNegativeInt(input.traffic);
  const conversions = clampNonNegativeInt(input.conversions);
  const revenueCents = clampNonNegativeInt(input.revenueCents);
  const taskSuccessRate = clampRate(input.taskSuccessRate);
  const costPerActionCents = Math.max(0, input.costPerActionCents ?? 0);
  const metadata = { ...(input.metadata ?? {}) };
  const bounceRatePercent =
    input.bounceRatePercent != null
      ? clampPercent(input.bounceRatePercent)
      : extractBounceRatePercent(metadata);
  if (bounceRatePercent != null) {
    metadata.bounceRatePercent = bounceRatePercent;
  }

  await db.insert(systemMetrics).values({
    companyId: input.companyId,
    sourceType: input.sourceType,
    sourceId: input.sourceId ?? null,
    traffic,
    conversions,
    revenueCents,
    taskSuccessRate,
    costPerActionCents,
    metadata,
    recordedAt: input.recordedAt ?? new Date(),
  });

  eventBus.publish("metrics.recorded", {
    companyId: input.companyId,
    sourceType: input.sourceType,
    sourceId: input.sourceId ?? null,
    traffic,
    conversions,
    revenueCents,
    taskSuccessRate,
    costPerActionCents,
    bounceRatePercent,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Aggregate recent metrics into one decision snapshot.
 */
export async function getRecentSystemMetricsSnapshot(
  db: Db,
  companyId: string,
  windowMinutes = 180,
): Promise<SystemMetricSnapshot> {
  const cutoff = new Date(Date.now() - windowMinutes * 60_000);
  const rows = await db
    .select()
    .from(systemMetrics)
    .where(and(eq(systemMetrics.companyId, companyId), gte(systemMetrics.recordedAt, cutoff)))
    .orderBy(desc(systemMetrics.recordedAt));

  if (rows.length === 0) {
    return {
      traffic: 0,
      conversions: 0,
      revenue: 0,
      total_revenue: 0,
      payment_conversions: 0,
      payment_conversion_rate: 0,
      revenue_per_user: 0,
      revenue_per_visit: 0,
      task_success_rate: 0,
      cost_per_action: 0,
      conversion_rate: 0,
      bounce_rate: 0,
      sample_count: 0,
      window_minutes: windowMinutes,
    };
  }

  const traffic = rows.reduce((sum, row) => sum + row.traffic, 0);
  const conversions = rows.reduce((sum, row) => sum + row.conversions, 0);
  const revenue = rows.reduce((sum, row) => sum + row.revenueCents, 0);
  const paymentRows = rows.filter((row) => row.revenueCents > 0);
  const paymentConversions = paymentRows.reduce((sum, row) => sum + row.conversions, 0);
  const payingUsers = new Set(
    paymentRows
      .map((row) => {
        if (!row.metadata || typeof row.metadata !== "object") return null;
        const metadata = row.metadata as Record<string, unknown>;
        const directEmail = metadata.email;
        if (typeof directEmail === "string" && directEmail.trim().length > 0) {
          return directEmail.trim().toLowerCase();
        }
        const checkoutMetadata = metadata.checkoutMetadata;
        if (!checkoutMetadata || typeof checkoutMetadata !== "object") return null;
        const checkoutRecord = checkoutMetadata as Record<string, unknown>;
        const checkoutEmail = checkoutRecord.email;
        if (typeof checkoutEmail === "string" && checkoutEmail.trim().length > 0) {
          return checkoutEmail.trim().toLowerCase();
        }
        return null;
      })
      .filter((value): value is string => Boolean(value)),
  );
  const taskSuccessRate = rows.reduce((sum, row) => sum + row.taskSuccessRate, 0) / rows.length;
  const costPerAction = rows.reduce((sum, row) => sum + row.costPerActionCents, 0) / rows.length;
  const conversionRate = traffic > 0 ? (conversions / traffic) * 100 : 0;
  const paymentConversionRate = traffic > 0 ? (paymentConversions / traffic) * 100 : 0;
  const revenuePerUser = revenue > 0
    ? revenue / Math.max(1, payingUsers.size || paymentConversions || conversions)
    : 0;
  const revenuePerVisit = traffic > 0 ? revenue / traffic : 0;
  const bounceRates = rows
    .map((row) => extractBounceRatePercent(row.metadata))
    .filter((value): value is number => value != null);
  const bounceRate = bounceRates.length > 0
    ? bounceRates.reduce((sum, value) => sum + value, 0) / bounceRates.length
    : 0;

  return {
    traffic,
    conversions,
    revenue,
    total_revenue: revenue,
    payment_conversions: paymentConversions,
    payment_conversion_rate: paymentConversionRate,
    revenue_per_user: revenuePerUser,
    revenue_per_visit: revenuePerVisit,
    task_success_rate: taskSuccessRate,
    cost_per_action: costPerAction,
    conversion_rate: conversionRate,
    bounce_rate: bounceRate,
    sample_count: rows.length,
    window_minutes: windowMinutes,
  };
}

export async function listRecentSystemMetrics(
  db: Db,
  companyId: string,
  limit = 100,
): Promise<Array<typeof systemMetrics.$inferSelect>> {
  return db
    .select()
    .from(systemMetrics)
    .where(eq(systemMetrics.companyId, companyId))
    .orderBy(desc(systemMetrics.recordedAt))
    .limit(limit);
}

export function estimateTokenCostCents(
  usage?: { inputTokens: number; outputTokens: number },
): number {
  if (!usage) return 0;
  // Provider-agnostic fallback estimate for control-loop signal quality.
  const totalTokens = Math.max(0, usage.inputTokens + usage.outputTokens);
  return Math.round(totalTokens * 0.002);
}
