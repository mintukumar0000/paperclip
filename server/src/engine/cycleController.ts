export type CycleMode = "launch" | "improve" | "scale" | "dominate";

export interface CycleMetrics {
  traffic: number;
  conversion: number;
  revenue: number;
}

function normalizeConversionRate(conversion: number): number {
  if (!Number.isFinite(conversion) || conversion <= 0) return 0;
  return conversion > 1 ? conversion / 100 : conversion;
}

export function decideNextCycle(metrics: CycleMetrics): CycleMode {
  const traffic = Number.isFinite(metrics.traffic) ? metrics.traffic : 0;
  const conversion = normalizeConversionRate(metrics.conversion);
  const revenue = Number.isFinite(metrics.revenue) ? metrics.revenue : 0;

  if (traffic < 100) return "launch";
  if (conversion < 0.02) return "improve";
  if (revenue < 100) return "scale";

  return "dominate";
}
