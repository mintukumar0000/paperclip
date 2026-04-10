import type { Db } from "@paperclipai/db";
import pino from "pino";
import { getRecentSystemMetricsSnapshot } from "../ai/feedback/metricsEngine.js";
import { analyzeCapabilityGaps } from "../ai/expansion/capabilityGapAnalyzer.js";
import { generateLandingVariants } from "../ai/distribution/landingVariants.js";
import { runEmailSequenceCycle } from "../ai/distribution/emailSequence.js";
import { resolvePublicBaseUrl, resolveSignupEndpoint } from "../public-base-url.js";
import { getActiveCompanyId, listScopedCompanyIds } from "../core/companyScope.js";
import { _runTrafficCycleForTest } from "../core/trafficLoop.js";
import { verifyEmail, verifyLanding, verifyReddit, verifyRevenue } from "./verifyOutcome.js";

const logger = pino({ name: "run-full-cycle" });

export type CycleMode = "launch" | "improve" | "scale" | "dominate";

interface CycleContext {
  db: Db;
  companyId: string;
  goal: string;
  mode: CycleMode;
}

interface ResearchResult {
  goal: string;
  mode: CycleMode;
  metrics: {
    traffic: number;
    conversionRate: number;
    revenueCents: number;
    revenuePerVisit: number;
  };
  capabilityGaps: string[];
}

interface StrategyResult {
  companyId: string;
  focus: string;
  hypotheses: string[];
  priorities: string[];
}

interface LandingResult {
  generatedCount: number;
  variantIds: string[];
}

interface DeployResult {
  url: string;
  signupEndpoint: string;
}

interface TrafficResult {
  triggered: boolean;
}

interface EmailResult {
  triggered: boolean;
}

export interface CycleTrackingSummary {
  landing: Awaited<ReturnType<typeof verifyLanding>>;
  reddit: Awaited<ReturnType<typeof verifyReddit>>;
  email: Awaited<ReturnType<typeof verifyEmail>>;
  revenue: Awaited<ReturnType<typeof verifyRevenue>>;
}

export interface FullCycleResult {
  success: true;
  companyId: string;
  goal: string;
  mode: CycleMode;
  deployUrl: string;
  tracking: CycleTrackingSummary;
}

export interface RunFullCycleOptions {
  db: Db;
  companyId?: string;
}

async function resolveCompanyId(db: Db, override?: string): Promise<string> {
  if (override) return override;

  const activeCompanyId = getActiveCompanyId();
  if (activeCompanyId) return activeCompanyId;

  const billingCompanyId = (process.env.BILLING_WEBHOOK_COMPANY_ID ?? "").trim();
  if (billingCompanyId) return billingCompanyId;

  const companyIds = await listScopedCompanyIds(db, { limit: 1 });
  const first = companyIds[0];
  if (!first) {
    throw new Error("runFullCycle requires at least one scoped company");
  }
  return first;
}

export async function runResearch(context: CycleContext): Promise<ResearchResult> {
  const metrics = await getRecentSystemMetricsSnapshot(context.db, context.companyId, 180);
  const gapAnalysis = await analyzeCapabilityGaps(context.db, context.companyId);

  return {
    goal: context.goal,
    mode: context.mode,
    metrics: {
      traffic: metrics.traffic,
      conversionRate: metrics.traffic > 0 ? metrics.conversions / metrics.traffic : 0,
      revenueCents: metrics.revenue,
      revenuePerVisit: metrics.revenue_per_visit,
    },
    capabilityGaps: gapAnalysis.gaps.map((gap) => gap.taskType),
  };
}

export async function generateStrategy(
  context: CycleContext,
  research: ResearchResult,
): Promise<StrategyResult> {
  const prioritiesByMode: Record<CycleMode, string[]> = {
    launch: ["ship_offer", "publish_landing", "start_traffic"],
    improve: ["improve_conversion", "reduce_friction", "tighten_message"],
    scale: ["scale_winning_channel", "increase_distribution", "expand_reach"],
    dominate: ["maximize_rpv", "optimize_pricing", "expand_capacity"],
  };

  return {
    companyId: context.companyId,
    focus: `${context.mode}:${context.goal}`,
    hypotheses: [
      `RPV increases when focus is ${context.mode}`,
      `Removing bottlenecks from ${research.capabilityGaps.slice(0, 3).join(", ") || "current workflow"} improves conversion`,
    ],
    priorities: prioritiesByMode[context.mode],
  };
}

export async function generateLanding(
  context: CycleContext,
  _strategy: StrategyResult,
): Promise<LandingResult> {
  const variants = await generateLandingVariants(context.db, context.companyId);
  if (!variants || variants.length === 0) {
    throw new Error("Landing generation produced no variants");
  }

  return {
    generatedCount: variants.length,
    variantIds: variants.map((variant) => variant.id),
  };
}

export async function deployLanding(
  _context: CycleContext,
  _landing: LandingResult,
): Promise<DeployResult> {
  const publicBase = resolvePublicBaseUrl();
  if (!publicBase) {
    throw new Error("No public base URL configured for deployment. Set PUBLIC_API_BASE or PAPERCLIP_AUTH_PUBLIC_BASE_URL.");
  }

  const signup = resolveSignupEndpoint(publicBase).endpoint;
  if (!signup) {
    throw new Error("No signup endpoint configured for deployment verification.");
  }

  return {
    url: publicBase,
    signupEndpoint: signup,
  };
}

export async function runTraffic(
  context: CycleContext,
  _strategy: StrategyResult,
  deploy: DeployResult,
): Promise<TrafficResult> {
  await _runTrafficCycleForTest({ db: context.db, baseUrl: deploy.url });
  return { triggered: true };
}

export async function runEmailSequence(
  context: CycleContext,
  _strategy: StrategyResult,
): Promise<EmailResult> {
  await runEmailSequenceCycle(context.db);
  return { triggered: true };
}

export async function setupTracking(
  context: CycleContext,
  deploy: DeployResult,
): Promise<CycleTrackingSummary> {
  const [landing, reddit, email, revenue] = await Promise.all([
    verifyLanding(context.db, context.companyId, deploy.url),
    verifyReddit(context.db, context.companyId),
    verifyEmail(context.db, context.companyId),
    verifyRevenue(context.db, context.companyId),
  ]);

  return { landing, reddit, email, revenue };
}

export async function runFullCycle(
  goal: string,
  mode: CycleMode = "launch",
  options?: RunFullCycleOptions,
): Promise<FullCycleResult> {
  if (!options?.db) {
    throw new Error("runFullCycle requires a Db instance in options.db");
  }

  const companyId = await resolveCompanyId(options.db, options.companyId);
  const context: CycleContext = { db: options.db, companyId, goal, mode };

  logger.info({ companyId, goal, mode }, "runFullCycle started");

  const research = await runResearch(context);
  const strategy = await generateStrategy(context, research);
  const landing = await generateLanding(context, strategy);
  const deploy = await deployLanding(context, landing);
  await runTraffic(context, strategy, deploy);
  await runEmailSequence(context, strategy);
  const tracking = await setupTracking(context, deploy);

  logger.info(
    {
      companyId,
      mode,
      deployUrl: deploy.url,
      landingSuccess: tracking.landing.success,
      redditSuccess: tracking.reddit.success,
      emailSuccess: tracking.email.success,
      revenueRpv: tracking.revenue.rpv,
      revenueTrend: tracking.revenue.trend,
      revenueDecision: tracking.revenue.decision,
    },
    "runFullCycle completed",
  );

  return {
    success: true,
    companyId,
    goal,
    mode,
    deployUrl: deploy.url,
    tracking,
  };
}
