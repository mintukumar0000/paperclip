import type { Db } from "@paperclipai/db";
import pino from "pino";
import { getStrategyState } from "./strategyBrain.js";
import { getRecentSystemMetricsSnapshot } from "../feedback/metricsEngine.js";
import { eventBus } from "../../events/eventBus.js";
import { runFullCycle } from "../../engine/runFullCycle.js";
import { decideNextCycle } from "../../engine/cycleController.js";
import { getActiveCompanyId, listScopedCompanyIds } from "../../core/companyScope.js";

const logger = pino({ name: "continuous-thinking" });

async function getPreferredCompanyId(db: Db): Promise<string | null> {
  const scopedCompanyId = getActiveCompanyId();
  if (scopedCompanyId) return scopedCompanyId;

  const billingCompanyId = (process.env.BILLING_WEBHOOK_COMPANY_ID ?? "").trim();
  if (billingCompanyId) return billingCompanyId;

  const companyIds = await listScopedCompanyIds(db, { limit: 1 });
  return companyIds[0] ?? null;
}

async function runThinkingCycle(db: Db): Promise<void> {
  const companyId = await getPreferredCompanyId(db);
  if (!companyId) {
    logger.debug("No company found for thinking loop");
    return;
  }

  let metrics;
  let previousMetrics;
  try {
    metrics = await getRecentSystemMetricsSnapshot(db, companyId, 60);
    previousMetrics = await getRecentSystemMetricsSnapshot(
      db,
      companyId,
      60,
      new Date(Date.now() - 60 * 60_000),
    );
  } catch {
    logger.debug("Metrics unavailable for thinking loop");
    return;
  }

  const strategyState = await getStrategyState(db, companyId);

  const currentGoal = strategyState?.currentStrategy?.trim() || "Increase revenue per visitor";
  const conversion = metrics.traffic > 0 ? metrics.conversions / metrics.traffic : 0;
  const revenueDollars = metrics.revenue / 100;
  const baselineMode = decideNextCycle({
    traffic: metrics.traffic,
    conversion,
    revenue: revenueDollars,
  });

  const previousRpv = Math.max(0, previousMetrics.revenue_per_visit);
  const currentRpv = Math.max(0, metrics.revenue_per_visit);
  const rpvDelta = currentRpv - previousRpv;
  const rpvTrend = previousRpv <= 0
    ? (currentRpv > 0 ? "increasing" : "flat")
    : rpvDelta > previousRpv * 0.05
      ? "increasing"
      : rpvDelta < -previousRpv * 0.05
        ? "down"
        : "flat";
  const rpvDecision = rpvTrend === "increasing"
    ? "scale"
    : rpvTrend === "down"
      ? "kill"
      : "improve";

  const nextMode = rpvDecision === "scale"
    ? "scale"
    : rpvDecision === "improve"
      ? "improve"
      : baselineMode;

  logger.info(
    {
      companyId,
      goal: currentGoal,
      mode: nextMode,
      traffic: metrics.traffic,
      conversion,
      revenueDollars,
      previousRpv,
      currentRpv,
      rpvTrend,
      rpvDecision,
    },
    "Continuous thinking selected next deterministic cycle",
  );

  const result = await runFullCycle(currentGoal, nextMode, { db, companyId });

  await eventBus.publish("thinking.action.triggered", {
    companyId,
    goal: currentGoal,
    mode: nextMode,
    deployUrl: result.deployUrl,
    landingSuccess: result.tracking.landing.success,
    redditSuccess: result.tracking.reddit.success,
    emailSuccess: result.tracking.email.success,
    revenueTrend: result.tracking.revenue.trend,
    revenueDecision: result.tracking.revenue.decision,
    revenueRpv: result.tracking.revenue.rpv,
    timestamp: new Date().toISOString(),
  });
}

let thinkingInterval: ReturnType<typeof setInterval> | null = null;

export function startContinuousThinking(db: Db, intervalMs = 15 * 60_000): () => void {
  const enabled = (process.env.CONTINUOUS_THINKING_ENABLED ?? "true").trim().toLowerCase();
  if (enabled === "false" || enabled === "0") {
    logger.info("Continuous thinking loop disabled");
    return () => {};
  }

  logger.info({ intervalMs }, "Starting continuous thinking loop (15-min micro-decisions)");

  void runThinkingCycle(db).catch((err) =>
    logger.error({ err }, "Initial thinking cycle failed"),
  );

  thinkingInterval = setInterval(() => {
    void runThinkingCycle(db).catch((err) =>
      logger.error({ err }, "Thinking cycle failed"),
    );
  }, intervalMs);

  return () => {
    if (thinkingInterval) {
      clearInterval(thinkingInterval);
      thinkingInterval = null;
      logger.info("Continuous thinking loop stopped");
    }
  };
}
