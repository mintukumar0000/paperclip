import type { Db } from "@paperclipai/db";
import { activityLog, and, eq, desc } from "@paperclipai/db";
import pino from "pino";
import {
  generateLandingVariants,
  getVariantResults,
  type LandingVariant,
} from "../distribution/landingVariants.js";
import { getRecentSystemMetricsSnapshot } from "../feedback/metricsEngine.js";
import { saveSkill } from "../skills/skillStore.js";
import { extractSkillFromPerformance } from "../skills/skillExtractor.js";
import { eventBus } from "../../events/eventBus.js";
import { listScopedCompanyIds } from "../../core/companyScope.js";

const logger = pino({ name: "conversion-controller" });

const MIN_IMPRESSIONS_TO_JUDGE = 25;
const KILL_THRESHOLD_PERCENT = 1.0;
const PROMOTE_THRESHOLD_PERCENT = 5.0;

interface ConversionCycleResult {
  companyId: string;
  variantsTested: number;
  winnerId: string | null;
  killed: string[];
  promoted: string[];
  newChallengersGenerated: boolean;
}

const activeVariants = new Map<string, {
  variants: LandingVariant[];
  promoted: Set<string>;
  killed: Set<string>;
}>();

export async function runConversionCycle(
  db: Db,
  companyId: string,
): Promise<ConversionCycleResult> {
  const { variants: performance, winner } = await getVariantResults(db, companyId);

  const killed: string[] = [];
  const promoted: string[] = [];

  const state = activeVariants.get(companyId) ?? { variants: [], promoted: new Set(), killed: new Set() };

  for (const v of performance) {
    if (v.impressions < MIN_IMPRESSIONS_TO_JUDGE) continue;

    if (v.conversionRate < KILL_THRESHOLD_PERCENT && !state.killed.has(v.variantId)) {
      state.killed.add(v.variantId);
      killed.push(v.variantId);

      logger.info(
        { companyId, variant: v.variantId, rate: v.conversionRate, impressions: v.impressions },
        "Killing low-performing variant",
      );

      try {
        await extractSkillFromPerformance(db, companyId, {
          type: "landing",
          metrics: { impressions: v.impressions, signups: v.signups },
          context: { variant: v.variantId, action: "killed" },
          content: `Landing variant ${v.variantId} killed at ${v.conversionRate.toFixed(1)}% conversion after ${v.impressions} impressions`,
        });
      } catch { /* skill extraction failed */ }
    }

    if (v.conversionRate >= PROMOTE_THRESHOLD_PERCENT && !state.promoted.has(v.variantId)) {
      state.promoted.add(v.variantId);
      promoted.push(v.variantId);

      logger.info(
        { companyId, variant: v.variantId, rate: v.conversionRate, impressions: v.impressions },
        "Promoting high-performing variant",
      );

      try {
        await extractSkillFromPerformance(db, companyId, {
          type: "landing",
          metrics: { impressions: v.impressions, signups: v.signups },
          context: { variant: v.variantId, action: "promoted" },
          content: `Landing variant ${v.variantId} promoted at ${v.conversionRate.toFixed(1)}% conversion after ${v.impressions} impressions`,
        });
      } catch { /* skill extraction failed */ }

      await saveSkill(db, companyId, {
        name: `winning_variant_${v.variantId}`,
        category: "conversion",
        pattern: `Variant ${v.variantId} converts at ${v.conversionRate.toFixed(1)}% — use this angle for all landing copy`,
        conditions: [`conversion_rate >= ${PROMOTE_THRESHOLD_PERCENT}%`],
        expectedOutcome: "Higher signup conversion",
        source: "landing",
        metadata: { impressions: v.impressions, signups: v.signups, rate: v.conversionRate },
      }).catch(() => {});
    }
  }

  let newChallengersGenerated = false;
  const totalTested = performance.filter((v) => v.impressions >= MIN_IMPRESSIONS_TO_JUDGE).length;
  const activeCount = totalTested - killed.length;

  if (killed.length >= 2 || (totalTested >= 4 && activeCount <= 2)) {
    try {
      const newVariants = await generateLandingVariants(db, companyId);
      if (newVariants.length > 0) {
        state.variants = newVariants;
        newChallengersGenerated = true;
        logger.info({ companyId, count: newVariants.length }, "Generated new challenger variants");
      }
    } catch (err) {
      logger.warn({ err }, "Challenger variant generation failed");
    }
  }

  activeVariants.set(companyId, state);

  await db.insert(activityLog).values({
    companyId,
    actorType: "system",
    actorId: "conversion-controller",
    agentId: null,
    runId: null,
    action: "conversion.cycle.completed",
    entityType: "company",
    entityId: companyId,
    details: {
      variantsTested: totalTested,
      winnerId: winner,
      killed,
      promoted,
      newChallengersGenerated,
      performance: performance.slice(0, 8).map((v) => ({
        id: v.variantId,
        impressions: v.impressions,
        signups: v.signups,
        rate: v.conversionRate.toFixed(2),
      })),
    },
  });

  eventBus.publish("conversion.cycle.completed", {
    companyId,
    variantsTested: totalTested,
    killed: killed.length,
    promoted: promoted.length,
    winnerId: winner,
    timestamp: new Date().toISOString(),
  });

  return { companyId, variantsTested: totalTested, winnerId: winner, killed, promoted, newChallengersGenerated };
}

let controllerInterval: ReturnType<typeof setInterval> | null = null;

export function startConversionController(db: Db, intervalMs = 2 * 60 * 60_000): () => void {
  const enabled = (process.env.CONVERSION_CONTROLLER_ENABLED ?? "true").trim().toLowerCase();
  if (enabled === "false" || enabled === "0") {
    logger.info("Conversion controller disabled");
    return () => {};
  }

  logger.info({ intervalMs }, "Starting conversion controller");

  setTimeout(async () => {
    try {
      const companyIds = await listScopedCompanyIds(db, { limit: 3 });
      for (const companyId of companyIds) {
        await runConversionCycle(db, companyId);
      }
    } catch (err) {
      logger.error({ err }, "Conversion controller initial cycle failed");
    }
  }, 8 * 60_000);

  controllerInterval = setInterval(async () => {
    try {
      const companyIds = await listScopedCompanyIds(db, { limit: 3 });
      for (const companyId of companyIds) {
        await runConversionCycle(db, companyId);
      }
    } catch (err) {
      logger.error({ err }, "Conversion controller cycle failed");
    }
  }, intervalMs);

  return () => {
    if (controllerInterval) {
      clearInterval(controllerInterval);
      controllerInterval = null;
    }
  };
}
