import type { Db } from "@paperclipai/db";
import { and, asc, eq, gte, inArray } from "@paperclipai/db";
import { activityLog, companies, goals, issues, systemDecisions, systemMetrics } from "@paperclipai/db";
import pino from "pino";
import { eventBus } from "../../events/eventBus.js";
import { issueService } from "../../services/issues.js";
import { strategyEngine } from "../../strategy/strategyEngine.js";
import { analyzeCapabilityGaps } from "../expansion/capabilityGapAnalyzer.js";
import { designAgents } from "../expansion/agentDesigner.js";
import { createAgent } from "../creation/agentFactory.js";
import { checkWorkforceStatus, canCreateAgent } from "./workforceLimits.js";
import {
  submitExpansionRequest,
  completeExpansion,
  type ExpansionRequest,
} from "./expansionApproval.js";
import {
  runBehaviorFeedback,
  type FeedbackAction,
} from "./economicFeedbackLoop.js";
import type { SystemMetricSnapshot } from "../feedback/metricsEngine.js";
import { analyzeMeisticsWithLLM } from "./llmDecisionAdvisor.js";
import { recordActionOutcome } from "../../memory/embeddingMemory.js";
import {
  createSystemDecision,
  getSystemControls,
  shouldRequireApprovalForAction,
  isDecisionKeyBlocked,
  setSystemDecisionExecutionResult,
} from "../../services/system-controls.js";
import { setCycleState } from "../../services/cycle-state.js";

const logger = pino({ name: "decision-engine" });

export type DecisionActionType = "create_issue" | "update_strategy" | "trigger_expansion" | "run_traffic_cycle";

export interface DecisionAction {
  type: DecisionActionType;
  key: string;
  reason: string;
  payload: Record<string, unknown>;
}

export interface DecisionCycleInput {
  companyId: string;
  metrics: SystemMetricSnapshot;
  source: "execution_loop" | "simulation_run" | "strategy_outcome" | "manual";
}

export interface DecisionCycleResult {
  companyId: string;
  source: DecisionCycleInput["source"];
  feedback: FeedbackAction[];
  actions: DecisionAction[];
  executed: Array<{ action: DecisionAction; success: boolean; details?: Record<string, unknown>; error?: string }>;
}

const ACTION_COOLDOWN_MS = 6 * 60 * 60_000; // 6h
const actionCooldown = new Map<string, number>();

type GoalPriority = "revenue" | "conversion" | "cac" | "traffic";

interface ActiveGoalContext {
  titles: string[];
  priorities: GoalPriority[];
}

interface ArtifactPerformanceSnapshot {
  artifactId: string;
  type: "reddit_post" | "deployment" | "checkout" | "email";
  channel: "reddit" | "twitter" | "indie_hackers" | "hacker_news" | null;
  url: string | null;
  linkedDecisionId: string | null;
  traceId: string | null;
  clicks: number;
  conversions: number;
  revenueCents: number;
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function parseGoalPriorities(goalsInput: string[]): GoalPriority[] {
  const priorities = new Set<GoalPriority>();
  for (const rawTitle of goalsInput) {
    const title = rawTitle.toLowerCase();
    if (title.includes("revenue") || title.includes("monet")) priorities.add("revenue");
    if (title.includes("conversion") || title.includes("checkout") || title.includes("funnel")) priorities.add("conversion");
    if (title.includes("cac") || title.includes("cost") || title.includes("acquisition")) priorities.add("cac");
    if (title.includes("traffic") || title.includes("growth") || title.includes("reach")) priorities.add("traffic");
  }
  return Array.from(priorities);
}

async function loadActiveGoalContext(db: Db, companyId: string): Promise<ActiveGoalContext> {
  const rows = await db
    .select({ title: goals.title })
    .from(goals)
    .where(
      and(
        eq(goals.companyId, companyId),
        inArray(goals.status, ["planned", "active"]),
      ),
    )
    .limit(32)
    .catch(() => []);

  const titles = rows
    .map((row) => readString(row.title))
    .filter((value): value is string => Boolean(value));
  return {
    titles,
    priorities: parseGoalPriorities(titles),
  };
}

function inferArtifactType(action: string, details: Record<string, unknown>): ArtifactPerformanceSnapshot["type"] | null {
  if (action.startsWith("distribution.reddit.")) return "reddit_post";
  if (action.startsWith("distribution.twitter.")) return "reddit_post";
  if (action.startsWith("distribution.indie_hackers.") || action.startsWith("distribution.hacker_news.")) return "reddit_post";
  if (action.startsWith("billing.checkout.")) return "checkout";
  if (action.startsWith("email.sequence.")) return "email";
  if (readString(details.deploymentUrl) || readString(details.deployment_url)) return "deployment";
  return null;
}

function inferArtifactChannel(action: string, details: Record<string, unknown>): ArtifactPerformanceSnapshot["channel"] {
  const raw = readString(details.channel);
  if (raw === "reddit" || raw === "twitter" || raw === "indie_hackers" || raw === "hacker_news") return raw;
  if (action.includes("reddit")) return "reddit";
  if (action.includes("twitter")) return "twitter";
  if (action.includes("indie_hackers")) return "indie_hackers";
  if (action.includes("hacker_news")) return "hacker_news";
  return null;
}

function inferArtifactUrl(details: Record<string, unknown>): string | null {
  return readString(details.postUrl)
    ?? readString(details.tweetUrl)
    ?? readString(details.checkoutUrl)
    ?? readString(details.checkout_url)
    ?? readString(details.deploymentUrl)
    ?? readString(details.deployment_url)
    ?? readString(details.url)
    ?? null;
}

function deriveArtifactId(action: string, details: Record<string, unknown>, fallbackId: string): string | null {
  const explicit = readString(details.artifactId) ?? readString(details.artifact_id);
  if (explicit) return explicit;
  const url = inferArtifactUrl(details);
  if (url) return `${action}:${url}`;
  const type = inferArtifactType(action, details);
  if (!type) return null;
  return `${action}:${fallbackId}`;
}

async function loadRecentArtifacts(
  db: Db,
  companyId: string,
): Promise<ArtifactPerformanceSnapshot[]> {
  const activityRows = await db
    .select({
      id: activityLog.id,
      action: activityLog.action,
      details: activityLog.details,
      createdAt: activityLog.createdAt,
    })
    .from(activityLog)
    .where(eq(activityLog.companyId, companyId))
    .orderBy(asc(activityLog.createdAt))
    .limit(500)
    .catch(() => []);

  const metricRows = await db
    .select({
      sourceId: systemMetrics.sourceId,
      traffic: systemMetrics.traffic,
      conversions: systemMetrics.conversions,
      revenueCents: systemMetrics.revenueCents,
      metadata: systemMetrics.metadata,
      recordedAt: systemMetrics.recordedAt,
    })
    .from(systemMetrics)
    .where(
      and(
        eq(systemMetrics.companyId, companyId),
        gte(systemMetrics.recordedAt, new Date(Date.now() - 7 * 24 * 60 * 60_000)),
      ),
    )
    .orderBy(asc(systemMetrics.recordedAt))
    .limit(1000)
    .catch(() => []);

  const artifacts = new Map<string, ArtifactPerformanceSnapshot>();

  for (const row of activityRows) {
    const details = toRecord(row.details);
    const type = inferArtifactType(row.action, details);
    if (!type) continue;

    const artifactId = deriveArtifactId(row.action, details, row.id);
    if (!artifactId) continue;

    const existing = artifacts.get(artifactId);
    const base: ArtifactPerformanceSnapshot = existing ?? {
      artifactId,
      type,
      channel: inferArtifactChannel(row.action, details),
      url: inferArtifactUrl(details),
      linkedDecisionId: readString(details.decisionId) ?? readString(details.decision_id),
      traceId: readString(details.traceId) ?? readString(details.trace_id),
      clicks: 0,
      conversions: 0,
      revenueCents: 0,
    };

    if (type === "reddit_post") {
      const upvotes = Number(details.upvotes ?? 0);
      const comments = Number(details.comments ?? 0);
      if (Number.isFinite(upvotes) && upvotes > 0) base.clicks += Math.round(upvotes);
      if (Number.isFinite(comments) && comments > 0) base.clicks += Math.round(comments);
    }

    artifacts.set(artifactId, base);
  }

  for (const row of metricRows) {
    const metadata = toRecord(row.metadata);
    const metricUrl = readString(metadata.postUrl)
      ?? readString(metadata.tweetUrl)
      ?? readString(metadata.checkoutUrl)
      ?? readString(metadata.checkout_url)
      ?? readString(metadata.url)
      ?? null;
    const metadataArtifactId = readString(metadata.artifactId)
      ?? readString(metadata.artifact_id)
      ?? (() => {
        const sourceId = readString(row.sourceId) ?? "metric";
        return metricUrl ? `${sourceId}:${metricUrl}` : null;
      })();

    if (!metadataArtifactId) continue;
    const existing = artifacts.get(metadataArtifactId)
      ?? (() => {
        if (!metricUrl) return null;
        return Array.from(artifacts.values()).find((artifact) => artifact.url === metricUrl) ?? null;
      })();
    if (!existing) continue;

    existing.clicks += Math.max(0, Number(row.traffic ?? 0));
    existing.conversions += Math.max(0, Number(row.conversions ?? 0));
    existing.revenueCents += Math.max(0, Number(row.revenueCents ?? 0));
  }

  return Array.from(artifacts.values()).slice(-120);
}

function annotateReasonWithGoals(reason: string, goalsContext: ActiveGoalContext): string {
  if (goalsContext.titles.length === 0) return reason;
  const references = goalsContext.titles.slice(0, 2).join(" | ");
  return `${reason} [goal-aligned: ${references}]`;
}

function applyGoalDrivenPolicy(
  actions: DecisionAction[],
  goalsContext: ActiveGoalContext,
  metrics: SystemMetricSnapshot,
): DecisionAction[] {
  if (goalsContext.priorities.length === 0) return actions;

  let filtered = actions.map((action) => ({
    ...action,
    reason: annotateReasonWithGoals(action.reason, goalsContext),
  }));

  const conversionGoal = goalsContext.priorities.includes("conversion");
  const revenueGoal = goalsContext.priorities.includes("revenue");
  const cacGoal = goalsContext.priorities.includes("cac");

  if (conversionGoal && metrics.conversion_rate < 2) {
    filtered = filtered.filter((action) => !action.key.includes("scale") && !action.key.includes("traffic"));
    filtered.unshift({
      type: "create_issue",
      key: "goal_conversion_focus",
      reason: annotateReasonWithGoals("Active goal requires conversion improvement before scaling traffic.", goalsContext),
      payload: {
        title: "Goal-first conversion optimization",
        description: "Active company goals prioritize conversion. Improve landing and checkout flow before traffic scaling actions.",
        priority: "urgent",
      },
    });
  }

  if (revenueGoal) {
    filtered.unshift({
      type: "create_issue",
      key: "goal_revenue_focus",
      reason: annotateReasonWithGoals("Revenue goal active. Prioritize monetization and pricing actions.", goalsContext),
      payload: {
        title: "Goal-first revenue optimization",
        description: "Run pricing tests, offer framing improvements, and checkout optimization tied to active revenue goals.",
        priority: "high",
      },
    });
  }

  if (cacGoal && metrics.cost_per_action > Math.max(1, metrics.revenue_per_visit)) {
    filtered = filtered.filter((action) => !action.key.includes("aggressive") && !action.key.includes("expansion"));
    filtered.unshift({
      type: "create_issue",
      key: "goal_cac_focus",
      reason: annotateReasonWithGoals("CAC goal active. Holding expensive growth actions until unit economics recover.", goalsContext),
      payload: {
        title: "Goal-first CAC recovery",
        description: "Reduce acquisition cost and improve traffic quality before aggressive scaling.",
        priority: "high",
      },
    });
  }

  return dedupeDecisionActions(filtered);
}

function addArtifactDrivenActions(
  actions: DecisionAction[],
  artifacts: ArtifactPerformanceSnapshot[],
  goalsContext: ActiveGoalContext,
): DecisionAction[] {
  if (artifacts.length === 0) return actions;

  const withRpv = artifacts
    .map((artifact) => ({
      artifact,
      rpv: artifact.clicks > 0 ? artifact.revenueCents / artifact.clicks : 0,
      conversionRate: artifact.clicks > 0 ? artifact.conversions / artifact.clicks : 0,
    }))
    .sort((left, right) => right.rpv - left.rpv);

  const best = withRpv[0];
  const next = [...actions];

  if (best && best.artifact.channel && best.rpv >= 20) {
    next.unshift({
      type: "run_traffic_cycle",
      key: `scale_${best.artifact.channel}_from_artifact`,
      reason: annotateReasonWithGoals(
        `Artifact ${best.artifact.artifactId} is outperforming (RPV ${(best.rpv / 100).toFixed(3)}). Scale this channel.`,
        goalsContext,
      ),
      payload: {
        channels: [best.artifact.channel],
        linkedArtifactId: best.artifact.artifactId,
        linkedDecisionId: best.artifact.linkedDecisionId,
      },
    });
  }

  const redditArtifacts = withRpv.filter((entry) => entry.artifact.channel === "reddit");
  const redditUnderperforming = redditArtifacts.length >= 3 && redditArtifacts.every((entry) => entry.rpv <= 5);
  if (redditUnderperforming) {
    next.unshift({
      type: "run_traffic_cycle",
      key: "explore_non_reddit_channels",
      reason: annotateReasonWithGoals(
        "Reddit output is stagnating. Explore Twitter and Hacker News to expand channel mix.",
        goalsContext,
      ),
      payload: {
        channels: ["twitter", "hacker_news"],
        exploration: true,
      },
    });
  }

  return dedupeDecisionActions(next);
}

function cooldownKey(companyId: string, key: string): string {
  return `${companyId}:${key}`;
}

function shouldExecuteAction(companyId: string, key: string): boolean {
  const mapKey = cooldownKey(companyId, key);
  const last = actionCooldown.get(mapKey) ?? 0;
  if (Date.now() - last < ACTION_COOLDOWN_MS) return false;
  actionCooldown.set(mapKey, Date.now());
  return true;
}

function mapFeedbackToDecisionActions(
  companyId: string,
  feedback: FeedbackAction[],
  metrics: SystemMetricSnapshot,
  options?: { trafficScaleThreshold?: number },
): DecisionAction[] {
  const actions: DecisionAction[] = [];

  for (const item of feedback) {
    if (item.type === "improve_landing_page") {
      actions.push({
        type: "create_issue",
        key: "improve_landing_page",
        reason: item.reason,
        payload: {
          title: "Rewrite landing headline to improve conversion rate",
          description:
            `Conversion is ${metrics.conversion_rate.toFixed(2)}% (<2%). Rewrite headline and supporting copy, then improve CTA placement and form UX.`,
          priority: "high",
        },
      });
    }

    if (item.type === "increase_content_output") {
      actions.push({
        type: "create_issue",
        key: "increase_content_output",
        reason: item.reason,
        payload: {
          title: "Increase content output to grow traffic",
          description:
            `Traffic is ${metrics.traffic} (below threshold). Produce and publish new SEO-focused content and distribution assets this cycle.`,
          priority: "high",
        },
      });
    }

    if (item.type === "update_strategy") {
      actions.push({
        type: "update_strategy",
        key: "update_strategy",
        reason: item.reason,
        payload: {},
      });
    }

    if (item.type === "trigger_expansion") {
      actions.push({
        type: "trigger_expansion",
        key: "trigger_expansion",
        reason: item.reason,
        payload: {},
      });
    }
  }

  // Safety rule for low task quality even if no explicit feedback action was emitted.
  if (metrics.sample_count >= 5 && metrics.task_success_rate < 0.6) {
    actions.push({
      type: "update_strategy",
      key: "update_strategy_low_task_success",
      reason: `Task success rate is low (${(metrics.task_success_rate * 100).toFixed(1)}%).`,
      payload: {},
    });
  }

  // Revenue-aware growth and pricing rules.
  if (metrics.sample_count >= 5 && metrics.conversions >= 3 && metrics.revenue <= 0) {
    actions.push({
      type: "create_issue",
      key: "monetization_gap_no_revenue",
      reason: "Users are converting but no revenue is being captured.",
      payload: {
        title: "Close monetization gap for converting traffic",
        description:
          `Detected ${metrics.conversions} conversions with $0 revenue in the current metrics window. Verify checkout wiring, product mapping, and payment webhook completion path.`,
        priority: "urgent",
      },
    });
  }

  if (metrics.conversions > 0 && metrics.revenue > 0) {
    const revenuePerConversion = metrics.revenue / Math.max(1, metrics.conversions);
    const costPerAction = metrics.cost_per_action;
    if (costPerAction > revenuePerConversion) {
      actions.push({
        type: "create_issue",
        key: "profitability_pricing_experiment",
        reason: "Acquisition cost per action is above revenue per conversion.",
        payload: {
          title: "Run profitability-focused pricing experiment",
          description:
            `Cost/action is ${costPerAction.toFixed(1)} cents while revenue/conversion is ${revenuePerConversion.toFixed(1)} cents. Test higher pricing, stronger offer packaging, or lower-cost channels.`,
          priority: "high",
        },
      });
    }

    const revenuePerVisitor = metrics.revenue_per_visit;
    if (metrics.traffic >= 75 && revenuePerVisitor < 25) {
      actions.push({
        type: "create_issue",
        key: "low_revenue_per_visitor",
        reason: "Revenue per visitor is low relative to current traffic volume.",
        payload: {
          title: "Improve monetization per visitor",
          description:
            `Revenue/visitor is ${revenuePerVisitor.toFixed(2)} cents at traffic=${metrics.traffic}. Introduce offer hierarchy (tripwire, core, upsell) and track per-step drop-off.`,
          priority: "high",
        },
      });
    }
  }

  if (metrics.sample_count >= 8 && metrics.traffic >= 80 && metrics.payment_conversion_rate < 1.0) {
    actions.push({
      type: "create_issue",
      key: "payment_conversion_under_target",
      reason: "Payment conversion rate is below monetization target.",
      payload: {
        title: "Improve payment conversion rate below 1%",
        description:
          `Payment conversion is ${metrics.payment_conversion_rate.toFixed(2)}% at traffic=${metrics.traffic}. Improve offer framing, checkout trust signals, and payment friction.`,
        priority: "high",
      },
    });
  }

  if (metrics.sample_count >= 8 && metrics.payment_conversions >= 3 && metrics.revenue_per_user < 200) {
    actions.push({
      type: "create_issue",
      key: "revenue_per_user_under_target",
      reason: "Revenue per user is below profit target.",
      payload: {
        title: "Increase revenue per paying user",
        description:
          `Revenue/user is ${metrics.revenue_per_user.toFixed(1)} cents. Add upsell tiers, price tests, and post-purchase bundles to reach >=200 cents per user.`,
        priority: "high",
      },
    });
  }

  // Strategy evolution rules beyond landing copy.
  if (metrics.sample_count >= 8 && metrics.traffic >= 120 && metrics.conversion_rate < 1.0) {
    actions.push({
      type: "create_issue",
      key: "audience_repositioning_test",
      reason: "High traffic with low conversion suggests weak audience-message fit.",
      payload: {
        title: "Run ICP repositioning and channel-fit test",
        description:
          `Traffic is ${metrics.traffic} but conversion is ${metrics.conversion_rate.toFixed(2)}%. Test at least two audience segments and channel-specific positioning to improve fit.`,
        priority: "high",
      },
    });
  }

  if (metrics.sample_count >= 8 && metrics.conversion_rate >= 2 && metrics.revenue < 1_000) {
    actions.push({
      type: "create_issue",
      key: "offer_ladder_expansion",
      reason: "Funnel converts but average monetization depth is still low.",
      payload: {
        title: "Expand offer ladder beyond entry product",
        description:
          `Conversion rate is ${metrics.conversion_rate.toFixed(2)}% with only ${metrics.revenue} cents revenue. Add higher-value offers and post-purchase upsell paths.`,
        priority: "medium",
      },
    });
  }

  if (metrics.sample_count >= 8 && metrics.conversion_rate > 3 && metrics.payment_conversion_rate >= 1.5) {
    actions.push({
      type: "create_issue",
      key: "auto_scale_distribution",
      reason: "Funnel conversion is strong enough to scale traffic safely.",
      payload: {
        title: "Scale traffic on winning conversion funnel",
        description:
          `Conversion is ${metrics.conversion_rate.toFixed(2)}% and payment conversion is ${metrics.payment_conversion_rate.toFixed(2)}%. Increase distribution volume on top channels while tracking CAC drift.`,
        priority: "medium",
      },
    });
  }

  const trafficScaleThreshold =
    typeof options?.trafficScaleThreshold === "number" && Number.isFinite(options.trafficScaleThreshold)
      ? Math.max(1, options.trafficScaleThreshold)
      : 120;
  if (metrics.sample_count >= 3 && metrics.traffic < trafficScaleThreshold) {
    actions.push({
      type: "create_issue",
      key: "reddit_autopost_boost",
      reason: `Traffic ${metrics.traffic} is below threshold ${trafficScaleThreshold}; increase autonomous Reddit distribution.`,
      payload: {
        title: "Boost autonomous Reddit posting on low traffic",
        description:
          `Traffic is ${metrics.traffic}. Generate multiple Reddit post variants, select the best-performing angle, and publish to core founder subreddits to recover top-of-funnel volume.`,
        priority: "high",
      },
    });
  }

  // Full-autonomy thresholds in cents: aggressively scale only when RPV is strong,
  // otherwise force conversion improvements first.
  if (metrics.sample_count >= 3 && metrics.traffic >= 20) {
    const rpvCents = metrics.revenue_per_visit;

    if (rpvCents > 50) {
      actions.push({
        type: "create_issue",
        key: "auto_scale_distribution_aggressive",
        reason: `RPV is healthy (${rpvCents.toFixed(2)} cents). Scale traffic volume now.`,
        payload: {
          title: "Aggressively scale distribution on high-RPV funnel",
          description:
            `Revenue per visit is ${rpvCents.toFixed(2)} cents (>50). Increase Reddit/Twitter cadence and expand winning content formats while monitoring reliability and CAC drift.`,
          priority: "urgent",
        },
      });
    }

    if (rpvCents < 10) {
      actions.push({
        type: "create_issue",
        key: "rpv_conversion_focus",
        reason: `RPV is weak (${rpvCents.toFixed(2)} cents). Improve conversion before adding traffic.`,
        payload: {
          title: "Focus conversion optimization before traffic scaling",
          description:
            `Revenue per visit is ${rpvCents.toFixed(2)} cents (<10). Prioritize landing copy, soft-paywall framing, and email sequence optimization before increasing distribution volume.`,
          priority: "urgent",
        },
      });
    }
  }

  // Explicit RPV thresholds for deterministic improve/scale routing.
  if (metrics.sample_count >= 3 && metrics.traffic >= 10) {
    const visitors = Math.max(1, metrics.traffic);
    const revenuePerVisitCents = metrics.revenue / visitors;
    const revenuePerVisitDollars = revenuePerVisitCents / 100;

    if (revenuePerVisitDollars < 0.01) {
      actions.push({
        type: "create_issue",
        key: "improve_landing_page",
        reason: `RPV is below threshold ($${revenuePerVisitDollars.toFixed(4)}). Improve conversion before scaling traffic.`,
        payload: {
          title: "Improve conversion when RPV is below $0.01",
          description:
            `Revenue per visitor is $${revenuePerVisitDollars.toFixed(4)} with traffic=${metrics.traffic}. Focus on conversion and checkout friction before scaling channels.`,
          priority: "high",
        },
      });
    }

    if (revenuePerVisitDollars > 0.05) {
      actions.push({
        type: "create_issue",
        key: "auto_scale_distribution",
        reason: `RPV is above threshold ($${revenuePerVisitDollars.toFixed(4)}). Scale winning traffic channels.`,
        payload: {
          title: "Scale traffic when RPV is above $0.05",
          description:
            `Revenue per visitor is $${revenuePerVisitDollars.toFixed(4)}. Increase distribution cadence on proven channels while monitoring CAC drift.`,
          priority: "high",
        },
      });
    }
  }

  // --- RPV-first prioritization: rank all actions by what increases Revenue Per Visitor most ---
  const rpv = metrics.traffic > 0 ? metrics.revenue / metrics.traffic : 0;
  if (metrics.sample_count >= 5 && metrics.traffic >= 20 && rpv < 50) {
    const rpvBottleneck = metrics.conversion_rate < 3
      ? "landing_conversion"
      : metrics.payment_conversion_rate < 1.5
      ? "payment_conversion"
      : metrics.revenue_per_user < 300
      ? "average_order_value"
      : "traffic_quality";

    const RPV_ACTION_MAP: Record<string, DecisionAction> = {
      landing_conversion: {
        type: "create_issue",
        key: "rpv_fix_landing",
        reason: `RPV bottleneck: signup conversion (${metrics.conversion_rate.toFixed(1)}%). Fix landing before scaling traffic.`,
        payload: { title: "RPV bottleneck: improve landing page conversion", description: `RPV is ${rpv.toFixed(1)} cents. Signup rate is ${metrics.conversion_rate.toFixed(1)}% — focus all effort on landing page optimization before anything else.`, priority: "urgent" },
      },
      payment_conversion: {
        type: "create_issue",
        key: "rpv_fix_checkout",
        reason: `RPV bottleneck: payment conversion (${metrics.payment_conversion_rate.toFixed(1)}%). Fix checkout/offer.`,
        payload: { title: "RPV bottleneck: improve checkout conversion", description: `RPV is ${rpv.toFixed(1)} cents. Payment rate is ${metrics.payment_conversion_rate.toFixed(1)}% — optimize pricing, offer framing, and trust signals.`, priority: "urgent" },
      },
      average_order_value: {
        type: "create_issue",
        key: "rpv_fix_aov",
        reason: `RPV bottleneck: revenue per user (${metrics.revenue_per_user.toFixed(0)} cents). Need upsells.`,
        payload: { title: "RPV bottleneck: increase average order value", description: `RPV is ${rpv.toFixed(1)} cents. Revenue per user is ${metrics.revenue_per_user.toFixed(0)} cents — add higher tiers, bundles, or upsells.`, priority: "high" },
      },
      traffic_quality: {
        type: "create_issue",
        key: "rpv_fix_traffic_quality",
        reason: `RPV bottleneck: traffic quality. Funnel converts but RPV still low.`,
        payload: { title: "RPV bottleneck: improve traffic quality", description: `RPV is ${rpv.toFixed(1)} cents despite decent conversion. Traffic quality or ICP targeting needs improvement.`, priority: "high" },
      },
    };

    const rpvAction = RPV_ACTION_MAP[rpvBottleneck];
    if (rpvAction) {
      actions.unshift(rpvAction);
    }
  }

  return dedupeDecisionActions(actions);
}

function dedupeDecisionActions(actions: DecisionAction[]): DecisionAction[] {
  const seen = new Set<string>();
  return actions.filter((action) => {
    const key = `${action.type}:${action.key}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function currentRPVCents(metrics: SystemMetricSnapshot): number {
  if (metrics.traffic <= 0) return 0;
  return metrics.revenue / metrics.traffic;
}

function projectedRPVDeltaCents(action: DecisionAction, currentRpv: number): number {
  const key = action.key.toLowerCase();

  if (key.includes("rpv") || key.includes("revenue") || key.includes("pricing") || key.includes("payment")) {
    return Math.max(1, currentRpv * 0.2);
  }

  if (key.includes("landing") || key.includes("conversion") || key.includes("offer") || key.includes("checkout")) {
    return Math.max(0.75, currentRpv * 0.15);
  }

  if (key.includes("audience") || key.includes("traffic_quality")) {
    return Math.max(0.5, currentRpv * 0.1);
  }

  if (key.includes("scale") || key.includes("content") || key.includes("traffic")) {
    // Scaling only passes the gate when it can preserve at least a small positive RPV uplift.
    return currentRpv > 0 ? currentRpv * 0.02 : 0;
  }

  if (key.includes("expansion")) {
    return Math.max(0.25, currentRpv * 0.05);
  }

  return 0;
}

function rejectAction(action: DecisionAction, currentRpv: number): boolean {
  const projected = currentRpv + projectedRPVDeltaCents(action, currentRpv);
  return projected <= currentRpv;
}

type RpvExecutionMode = "exploration" | "validation" | "optimization";

function getValidationRevenueThresholdCents(): number {
  const raw = Number(process.env.DECISION_RPV_VALIDATION_REVENUE_CENTS ?? 10_000);
  if (!Number.isFinite(raw)) return 10_000;
  return Math.max(0, Math.round(raw));
}

function selectRpvExecutionMode(metrics: SystemMetricSnapshot): RpvExecutionMode {
  if (metrics.revenue <= 0) {
    return "exploration";
  }
  if (metrics.revenue < getValidationRevenueThresholdCents()) {
    return "validation";
  }
  return "optimization";
}

function rejectActionInValidationMode(action: DecisionAction, currentRpv: number): boolean {
  const projected = currentRpv + projectedRPVDeltaCents(action, currentRpv);
  if (projected > currentRpv) {
    return false;
  }

  // In validation mode, only suppress expensive/no-uplift actions.
  const key = action.key.toLowerCase();
  const highCostAction = key.includes("scale") || key.includes("expansion");
  return highCostAction;
}

async function issueAlreadyOpen(db: Db, companyId: string, title: string): Promise<boolean> {
  const row = await db
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.title, title),
        inArray(issues.status, ["backlog", "todo", "in_progress", "in_review", "blocked"]),
      ),
    )
    .then((rows) => rows[0] ?? null);

  return !!row;
}

async function executeAction(
  db: Db,
  companyId: string,
  action: DecisionAction,
  traceId: string,
  decisionId?: string,
): Promise<{ success: boolean; details?: Record<string, unknown>; error?: string }> {
  if (!shouldExecuteAction(companyId, action.key)) {
    return {
      success: true,
      details: { skipped: true, reason: "cooldown_active" },
    };
  }

  if (action.type === "create_issue") {
    const svc = issueService(db);
    const title = String(action.payload.title ?? "Autonomous follow-up");
    if (await issueAlreadyOpen(db, companyId, title)) {
      return { success: true, details: { skipped: true, reason: "issue_already_open", title } };
    }

    const issue = await svc.create(companyId, {
      title,
      description: String(action.payload.description ?? "Auto-generated by decision engine."),
      priority: String(action.payload.priority ?? "high") as "urgent" | "high" | "medium" | "low" | "none",
      status: "backlog",
    });

    return {
      success: true,
      details: { issueId: issue.id, issueIdentifier: issue.identifier ?? null, title: issue.title, status: issue.status },
    };
  }

  if (action.type === "update_strategy") {
    const plan = await strategyEngine(db).runForCompany(companyId);
    return {
      success: true,
      details: {
        goalsAnalyzed: plan.goalSnapshots.length,
        tasksGenerated: plan.generatedTasks.length,
      },
    };
  }

  if (action.type === "trigger_expansion") {
    const workforce = await checkWorkforceStatus(db, companyId);
    if (!workforce.canExpand) {
      return { success: true, details: { skipped: true, reason: "workforce_limits", violations: workforce.violations } };
    }

    const gapResult = await analyzeCapabilityGaps(db, companyId);
    if (gapResult.gaps.length === 0) {
      return { success: true, details: { skipped: true, reason: "no_capability_gaps" } };
    }

    const design = await designAgents(db, companyId, gapResult.gaps.slice(0, 2));
    if (design.designs.length === 0) {
      return { success: true, details: { skipped: true, reason: "no_agent_designs" } };
    }

    const requests: Array<{ requestId: string; role: string; status: string; createdAgentId?: string }> = [];

    for (const spec of design.designs.slice(0, 2)) {
      const budgetCheck = await canCreateAgent(db, companyId, spec.budgetCents);
      if (!budgetCheck.allowed) {
        requests.push({
          requestId: "",
          role: spec.role,
          status: `blocked:${budgetCheck.reason ?? "unknown"}`,
        });
        continue;
      }

      const linkedGap = gapResult.gaps.find((gap) => gap.suggestedRole === spec.role) ?? null;
      const request: ExpansionRequest = await submitExpansionRequest(
        db,
        companyId,
        spec,
        linkedGap,
        "decision-engine",
      );

      let createdAgentId: string | undefined;
      if (request.status === "approved") {
        const created = await createAgent(db, {
          companyId,
          design: spec,
          expansionRequestId: request.id,
        });
        if (created.success && created.agentId) {
          await completeExpansion(db, request.id, companyId, created.agentId);
          createdAgentId = created.agentId;
        }
      }

      requests.push({
        requestId: request.id,
        role: spec.role,
        status: request.status,
        createdAgentId,
      });
    }

    return { success: true, details: { expansionRequests: requests } };
  }

  if (action.type === "run_traffic_cycle") {
    const { runTrafficCycleWithDecision } = await import("../../core/trafficLoop.js");
    const baseUrl =
      typeof action.payload.baseUrl === "string" && action.payload.baseUrl.trim().length > 0
        ? action.payload.baseUrl.trim()
        : (process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL ?? "http://localhost:3100").trim();

    const requestedChannels = Array.isArray(action.payload.channels)
      ? action.payload.channels.filter((entry): entry is "reddit" | "twitter" | "indie_hackers" | "hacker_news" => (
        entry === "reddit" || entry === "twitter" || entry === "indie_hackers" || entry === "hacker_news"
      ))
      : [];

    const summary = await runTrafficCycleWithDecision({ db, baseUrl }, {
      bypassDecisionGate: true,
      decisionId,
      traceId,
      channelsOverride: requestedChannels,
    });

    return {
      success: summary.successCount > 0 || summary.failCount === 0,
      details: {
        successCount: summary.successCount,
        failCount: summary.failCount,
        error: summary.error ?? null,
      },
      error: summary.error,
    };
  }

  return { success: false, error: `Unsupported action type: ${action.type}` };
}

async function createFallbackForSkippedAction(
  db: Db,
  companyId: string,
  action: DecisionAction,
  skipReason: string,
): Promise<Record<string, unknown> | null> {
  const normalizedKey = action.key.toLowerCase();
  let fallbackTitle = `Fallback: minimum viable execution for ${action.key}`;
  let fallbackDescription = `Primary action ${action.key} was skipped (reason=${skipReason}). Run a minimal executable variant and report measurable outcome.`;

  if (normalizedKey.includes("content") || normalizedKey.includes("distribution") || normalizedKey.includes("reddit")) {
    fallbackTitle = "Fallback: publish one minimal Reddit validation post";
    fallbackDescription = "Primary distribution action was skipped. Post one short text update in a safe subreddit (SideProject/indiehackers), include body text, and capture resulting post URL.";
  } else if (normalizedKey.includes("payment") || normalizedKey.includes("checkout") || normalizedKey.includes("revenue")) {
    fallbackTitle = "Fallback: run checkout smoke test";
    fallbackDescription = "Monetization action was skipped. Run one end-to-end checkout smoke test and capture blockers with screenshots/errors.";
  }

  if (await issueAlreadyOpen(db, companyId, fallbackTitle)) {
    return {
      skipped: true,
      reason: "fallback_issue_already_open",
      fallbackTitle,
    };
  }

  const issue = await issueService(db).create(companyId, {
    title: fallbackTitle,
    description: fallbackDescription,
    priority: "high",
    status: "backlog",
  });

  return {
    fallbackIssueId: issue.id,
    fallbackIssueIdentifier: issue.identifier ?? null,
    fallbackTitle: issue.title,
    fallbackReason: skipReason,
  };
}

// STEP 2: Decision → Action bridge
// When the decision engine creates an issue, also trigger direct execution
// for action types that have automated handlers.
async function executeDirectAction(
  db: Db,
  companyId: string,
  action: DecisionAction,
): Promise<{ attempted: boolean; success: boolean; details?: Record<string, unknown> }> {
  const key = action.key;

  if (key === "increase_content_output" || key === "auto_scale_distribution" || key === "auto_scale_distribution_aggressive" || key === "reddit_autopost_boost") {
    try {
      const { _runTrafficCycleForTest } = await import("../../core/trafficLoop.js");
      const baseUrl = (
        process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL ??
        "http://localhost:3100"
      ).trim();
      const cycles = key === "auto_scale_distribution_aggressive" ? 2 : 1;
      logger.info({ companyId, key }, "Decision → Action: triggering traffic loop cycle");
      let successCount = 0;
      let failCount = 0;
      let lastError: string | null = null;

      for (let index = 0; index < cycles; index++) {
        const summary = await _runTrafficCycleForTest({ db, baseUrl });
        successCount += summary.successCount;
        failCount += summary.failCount;
        if (summary.error) {
          lastError = summary.error;
        }
      }

      return {
        attempted: true,
        success: successCount > 0,
        details: {
          successCount,
          failCount,
          cycles,
          error: lastError,
        },
      };
    } catch (err) {
      logger.warn({ err, key }, "Direct action execution failed for traffic trigger");
      return {
        attempted: true,
        success: false,
        details: {
          error: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  if (key === "rpv_conversion_focus") {
    try {
      const { generateLandingVariants } = await import("../distribution/landingVariants.js");
      const { runEmailSequenceCycle } = await import("../distribution/emailSequence.js");

      const variants = await generateLandingVariants(db, companyId);
      await runEmailSequenceCycle(db);

      eventBus.publish("decision.direct_action", {
        companyId,
        actionKey: key,
        actionType: "conversion_focus",
        timestamp: new Date().toISOString(),
      });

      return {
        attempted: true,
        success: variants.length > 0,
        details: {
          variantCount: variants.length,
          emailSequenceTriggered: true,
        },
      };
    } catch (err) {
      return {
        attempted: true,
        success: false,
        details: {
          error: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  if (key === "improve_landing_page") {
    logger.info({ companyId, key }, "Decision → Action: landing page improvement flagged for agent execution");
    eventBus.publish("decision.direct_action", {
      companyId,
      actionKey: key,
      actionType: "landing_rewrite",
      timestamp: new Date().toISOString(),
    });
    return {
      attempted: true,
      success: false,
      details: { dispatched: true, dispatchType: "event" },
    };
  }

  if (key === "payment_conversion_under_target" || key === "low_revenue_per_visitor") {
    logger.info({ companyId, key }, "Decision → Action: monetization optimization flagged");
    eventBus.publish("decision.direct_action", {
      companyId,
      actionKey: key,
      actionType: "monetization_optimization",
      timestamp: new Date().toISOString(),
    });
    return {
      attempted: true,
      success: false,
      details: { dispatched: true, dispatchType: "event" },
    };
  }

  return { attempted: false, success: false, details: { reason: "no_direct_handler" } };
}

function deriveDecisionEvidence(
  action: DecisionAction,
  metrics: SystemMetricSnapshot,
): { metricName: string | null; metricValue: number | null; thresholdValue: number | null } {
  const key = action.key.toLowerCase();
  if (key.includes("traffic") || key.includes("reddit") || key.includes("distribution")) {
    return { metricName: "traffic", metricValue: metrics.traffic, thresholdValue: 120 };
  }
  if (key.includes("conversion")) {
    return { metricName: "conversion_rate", metricValue: metrics.conversion_rate, thresholdValue: 2 };
  }
  if (key.includes("payment")) {
    return {
      metricName: "payment_conversion_rate",
      metricValue: metrics.payment_conversion_rate,
      thresholdValue: 1,
    };
  }
  if (key.includes("revenue") || key.includes("pricing") || key.includes("monetization")) {
    return { metricName: "revenue_per_visit", metricValue: metrics.revenue_per_visit, thresholdValue: 50 };
  }
  if (key.includes("task") || key.includes("strategy")) {
    return { metricName: "task_success_rate", metricValue: metrics.task_success_rate, thresholdValue: 0.6 };
  }
  return { metricName: null, metricValue: null, thresholdValue: null };
}

async function drainExecutableDecisions(
  db: Db,
  companyId: string,
  source: DecisionCycleInput["source"],
): Promise<DecisionCycleResult["executed"]> {
  const queued = await db
    .select()
    .from(systemDecisions)
    .where(
      and(
        eq(systemDecisions.companyId, companyId),
        inArray(systemDecisions.status, ["approved", "pending"]),
      ),
    )
    .orderBy(asc(systemDecisions.createdAt))
    .limit(25)
    .catch(() => []);

  if (queued.length === 0) return [];

  const replayed: DecisionCycleResult["executed"] = [];
  for (const decision of queued) {
    const payload = toRecord(decision.actionPayload);
    const action: DecisionAction = {
      type: decision.actionType as DecisionActionType,
      key: decision.actionKey,
      reason: decision.reason,
      payload,
    };

    const result = await executeDecisionActionNow(db, companyId, action, source, decision.id);
    await setSystemDecisionExecutionResult(db, companyId, decision.id, {
      status: result.success ? "executed" : "failed",
      note: result.error ?? null,
    });

    replayed.push({
      action,
      success: result.success,
      details: {
        ...(result.details ?? {}),
        replayed: true,
        status: result.success ? "success" : "failed",
        decisionId: decision.id,
      },
      error: result.error,
    });

    await db.insert(activityLog).values({
      companyId,
      actorType: "system",
      actorId: "decision-engine",
      agentId: null,
      runId: null,
      action: "decision.execution.replayed",
      entityType: "company",
      entityId: companyId,
      details: {
        status: result.success ? "success" : "failed",
        source,
        decisionId: decision.id,
        actionType: action.type,
        actionKey: action.key,
        replayed: true,
        error: result.error ?? null,
      },
    });
  }

  return replayed;
}

export async function executeDecisionActionNow(
  db: Db,
  companyId: string,
  action: DecisionAction,
  source: DecisionCycleInput["source"] | "approval" = "manual",
  decisionId?: string,
): Promise<{ success: boolean; details?: Record<string, unknown>; error?: string }> {
  try {
    const payloadTraceId = readString(action.payload.traceId) ?? null;
    const traceId = payloadTraceId ?? `decision_action:${companyId}:${decisionId ?? action.key}:${Date.now()}`;
    const maxAttemptsRaw = Number(process.env.DECISION_ACTION_MAX_RETRIES ?? 2);
    const maxAttempts = Number.isFinite(maxAttemptsRaw)
      ? Math.max(1, Math.min(4, Math.trunc(maxAttemptsRaw)))
      : 2;

    let result = await executeAction(db, companyId, action, traceId, decisionId);
    let attempts = 1;
    while (!result.success && attempts < maxAttempts) {
      attempts += 1;
      result = await executeAction(db, companyId, action, traceId, decisionId);
    }

    const details: Record<string, unknown> = result.details ? { ...result.details } : {};
    details.traceId = traceId;
    details.attempts = attempts;
    if (decisionId) details.decisionId = decisionId;
    const issueId = typeof details.issueId === "string" ? details.issueId : null;
    const skipped = details.skipped === true;

    if (skipped) {
      const fallbackReason = typeof details.reason === "string" ? details.reason : "skipped";
      const fallback = await createFallbackForSkippedAction(db, companyId, action, fallbackReason);
      if (fallback) {
        details.fallback = fallback;
        details.fallbackTriggered = true;
      }
    }

    if (result.success && !skipped) {
      const direct = await executeDirectAction(db, companyId, action);
      details.directExecution = direct;

      if (issueId && direct.success) {
        await issueService(db).update(issueId, { status: "done" });
        details.issueCompleted = true;
      }
    }

    const completed = !skipped && (details.issueCompleted === true || action.type !== "create_issue");
    details.completed = completed;
    const success = result.success && !skipped;

    await recordActionOutcome(db, companyId, action.key, success, {
      actionType: action.type,
      reason: action.reason,
      skipped,
      source,
      decisionId: decisionId ?? null,
      traceId,
      attempts,
    }).catch(() => {});

    return { success, details, error: result.error };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Action execution failed";
    return { success: false, error: message };
  }
}

export async function runAutonomousDecisionCycle(
  db: Db,
  input: DecisionCycleInput,
): Promise<DecisionCycleResult> {
  const company = await db
    .select({ id: companies.id, status: companies.status })
    .from(companies)
    .where(eq(companies.id, input.companyId))
    .then((rows) => rows[0] ?? null);

  if (!company || company.status !== "active") {
    logger.info(
      { companyId: input.companyId, status: company?.status ?? "missing", source: input.source },
      "Skipping autonomous decision cycle for inactive company",
    );
    return {
      companyId: input.companyId,
      source: input.source,
      feedback: [],
      actions: [],
      executed: [],
    };
  }

  const cycleStartedAt = Date.now();
  const cycleTraceId = `decision_cycle:${input.companyId}:${cycleStartedAt}`;
  await setCycleState(db, input.companyId, "decision_engine", {
    status: "running",
    stage: "planning",
    currentAction: "collect_feedback",
    lastError: null,
    lastRunStartedAt: new Date(cycleStartedAt),
    details: { source: input.source, traceId: cycleTraceId },
  });

  try {
    const goalsContext = await loadActiveGoalContext(db, input.companyId);
    const artifactSnapshots = await loadRecentArtifacts(db, input.companyId);
    const feedback = runBehaviorFeedback(input.companyId, {
      traffic: input.metrics.traffic,
      conversions: input.metrics.conversions,
      revenueCents: input.metrics.revenue,
      taskSuccessRate: input.metrics.task_success_rate,
      costPerActionCents: input.metrics.cost_per_action,
      conversionRatePercent: input.metrics.conversion_rate,
      bounceRatePercent: input.metrics.bounce_rate,
      sampleCount: input.metrics.sample_count,
    });

    const controls = await getSystemControls(db, input.companyId);
    const decisionMode = (controls.decisionMode ?? "approval_for_high_impact") as
      | "approval_required"
      | "approval_for_high_impact"
      | "auto_execute";
    const trafficScaleThreshold = Math.max(30, controls.postFrequency * 60);

    const ruleActions = mapFeedbackToDecisionActions(input.companyId, feedback, input.metrics, {
      trafficScaleThreshold,
    });

    let llmAdvice: Awaited<ReturnType<typeof analyzeMeisticsWithLLM>> = null;
    const llmEnabled = (process.env.LLM_DECISION_ENABLED ?? "true").trim().toLowerCase() !== "false";
    if (llmEnabled && input.metrics.sample_count >= 3) {
      try {
        llmAdvice = await analyzeMeisticsWithLLM(db, input.companyId, input.metrics, ruleActions);
      } catch (err) {
        logger.warn({ err }, "LLM decision advisor error (non-fatal)");
      }
    }

    const proposedActions = llmAdvice?.suggestedActions
      ? dedupeDecisionActions([...ruleActions, ...llmAdvice.suggestedActions])
      : ruleActions;

    const goalAlignedActions = applyGoalDrivenPolicy(proposedActions, goalsContext, input.metrics);
    const artifactAlignedActions = addArtifactDrivenActions(goalAlignedActions, artifactSnapshots, goalsContext);

    const currentRpv = currentRPVCents(input.metrics);
    const rpvMode = selectRpvExecutionMode(input.metrics);
    const actions = artifactAlignedActions.filter((action) => {
      if (rpvMode === "exploration") return true;
      if (rpvMode === "validation") return !rejectActionInValidationMode(action, currentRpv);
      return !rejectAction(action, currentRpv);
    });
    const rejectedByRpv = artifactAlignedActions.filter((action) => {
      if (rpvMode === "exploration") return false;
      if (rpvMode === "validation") return rejectActionInValidationMode(action, currentRpv);
      return rejectAction(action, currentRpv);
    });

    await db.insert(activityLog).values({
      companyId: input.companyId,
      actorType: "system",
      actorId: "decision-engine",
      agentId: null,
      runId: null,
      action: "decision.execution.plan",
      entityType: "company",
      entityId: input.companyId,
      details: {
        status: "pending",
        source: input.source,
        decisionMode,
        rpvMode,
        traceId: cycleTraceId,
        activeGoals: goalsContext.titles,
        goalPriorities: goalsContext.priorities,
        artifactsObserved: artifactSnapshots.length,
        proposedCount: artifactAlignedActions.length,
        actionCount: actions.length,
        rejectedByRpv: rejectedByRpv.map((entry) => entry.key),
      },
    });

    if (llmAdvice) {
      await db.insert(activityLog).values({
        companyId: input.companyId,
        actorType: "system",
        actorId: "decision-engine-llm",
        agentId: null,
        runId: null,
        action: "ai.decision.llm.analysis",
        entityType: "company",
        entityId: input.companyId,
        details: {
          reasoning: llmAdvice.reasoning,
          pricingAdvice: llmAdvice.pricingAdvice,
          audienceAdvice: llmAdvice.audienceAdvice,
          channelAdvice: llmAdvice.channelAdvice,
          suggestedActionCount: llmAdvice.suggestedActions.length,
          source: input.source,
          traceId: cycleTraceId,
        },
      });
    }

    const replayedDecisions = await drainExecutableDecisions(db, input.companyId, input.source);
    const executed: DecisionCycleResult["executed"] = [...replayedDecisions];
    await setCycleState(db, input.companyId, "decision_engine", {
      status: "running",
      stage: "executing",
      currentAction: actions[0]?.key ?? "no_actions",
      details: {
        source: input.source,
        traceId: cycleTraceId,
        replayedCount: replayedDecisions.length,
        actionCount: actions.length,
      },
    });

    for (const action of actions) {
      const actionPayload: Record<string, unknown> = {
        ...action.payload,
        traceId: readString(action.payload.traceId) ?? cycleTraceId,
        goalContext: goalsContext.titles,
      };
      const actionWithTrace: DecisionAction = {
        ...action,
        payload: actionPayload,
      };
      const evidence = deriveDecisionEvidence(action, input.metrics);
      const requiresApproval =
        controls.autonomyLevel === "manual"
        || shouldRequireApprovalForAction(decisionMode, action.type, action.key);
      const decisionRow = await createSystemDecision(db, {
        companyId: input.companyId,
        source: input.source,
        actionType: actionWithTrace.type,
        actionKey: actionWithTrace.key,
        reason: actionWithTrace.reason,
        metricName: evidence.metricName,
        metricValue: evidence.metricValue,
        thresholdValue: evidence.thresholdValue,
        actionPayload: actionWithTrace.payload,
        status: requiresApproval ? "awaiting_approval" : "pending",
      });

      if (requiresApproval) {
        const pendingDetails = {
          status: "pending",
          source: input.source,
          traceId: cycleTraceId,
          decisionMode,
          decisionId: decisionRow.id,
          pendingApproval: true,
          actionType: actionWithTrace.type,
          actionKey: actionWithTrace.key,
          reason: actionWithTrace.reason,
          linkedArtifactId: readString(actionWithTrace.payload.linkedArtifactId),
        };
        executed.push({ action: actionWithTrace, success: false, details: pendingDetails });

        await db.insert(activityLog).values({
          companyId: input.companyId,
          actorType: "system",
          actorId: "decision-engine",
          agentId: null,
          runId: null,
          action: "decision.execution.awaiting_approval",
          entityType: "company",
          entityId: input.companyId,
          details: pendingDetails,
        });
        continue;
      }

      if (controls.autonomyLevel === "semi") {
        const blockedByOverride = await isDecisionKeyBlocked(db, input.companyId, actionWithTrace.key, 24);
        if (blockedByOverride) {
          await setSystemDecisionExecutionResult(db, input.companyId, decisionRow.id, {
            status: "overridden",
            note: "blocked by recent operator rejection",
          });
          const blockedDetails = {
            status: "blocked",
            decisionId: decisionRow.id,
            skipped: true,
            traceId: cycleTraceId,
            reason: "blocked_by_operator_override",
            actionType: actionWithTrace.type,
            actionKey: actionWithTrace.key,
          };
          executed.push({
            action: actionWithTrace,
            success: false,
            details: blockedDetails,
          });
          await db.insert(activityLog).values({
            companyId: input.companyId,
            actorType: "system",
            actorId: "decision-engine",
            agentId: null,
            runId: null,
            action: "decision.execution.blocked",
            entityType: "company",
            entityId: input.companyId,
            details: blockedDetails,
          });
          continue;
        }
      }

      const actionResult = await executeDecisionActionNow(db, input.companyId, actionWithTrace, input.source, decisionRow.id);
      await setSystemDecisionExecutionResult(db, input.companyId, decisionRow.id, {
        status: actionResult.success ? "executed" : "failed",
        note: actionResult.error ?? null,
      });

      const details: Record<string, unknown> = {
        ...(actionResult.details ?? {}),
        status: actionResult.success ? "success" : "failed",
        traceId: cycleTraceId,
        decisionId: decisionRow.id,
      };
      const issueId = typeof details.issueId === "string" ? details.issueId : null;

      executed.push({ action: actionWithTrace, success: actionResult.success, details, error: actionResult.error });

      await db.insert(activityLog).values({
        companyId: input.companyId,
        actorType: "system",
        actorId: "decision-engine",
        agentId: null,
        runId: null,
        action: "decision.execution.result",
        entityType: issueId ? "issue" : "company",
        entityId: issueId ?? input.companyId,
        details: {
          source: input.source,
          traceId: cycleTraceId,
          decisionMode,
          actionType: actionWithTrace.type,
          actionKey: actionWithTrace.key,
          reason: actionWithTrace.reason,
          success: actionResult.success,
          ...details,
          error: actionResult.error ?? null,
        },
      });

      eventBus.publish("decision.action.executed", {
        companyId: input.companyId,
        source: input.source,
        actionType: actionWithTrace.type,
        key: actionWithTrace.key,
        success: actionResult.success,
        traceId: cycleTraceId,
        details,
        error: actionResult.error ?? null,
        timestamp: new Date().toISOString(),
      });
    }

    const result: DecisionCycleResult = {
      companyId: input.companyId,
      source: input.source,
      feedback,
      actions,
      executed,
    };

    eventBus.publish("decision.cycle.completed", {
      companyId: input.companyId,
      source: input.source,
      feedbackCount: feedback.length,
      actionCount: actions.length,
      executedCount: executed.length,
      successCount: executed.filter((entry) => entry.success).length,
      traceId: cycleTraceId,
      timestamp: new Date().toISOString(),
    });

    await db.insert(activityLog).values({
      companyId: input.companyId,
      actorType: "system",
      actorId: "decision-engine",
      agentId: null,
      runId: null,
      action: "decision.execution.cycle.result",
      entityType: "company",
      entityId: input.companyId,
      details: {
        status: "success",
        source: input.source,
        traceId: cycleTraceId,
        replayedCount: replayedDecisions.length,
        feedbackCount: feedback.length,
        actionCount: actions.length,
        executedCount: executed.length,
        successCount: executed.filter((entry) => entry.success).length,
        pendingApprovalCount: executed.filter((entry) => entry.details?.pendingApproval === true).length,
      },
    });

    await setCycleState(db, input.companyId, "decision_engine", {
      status: "completed",
      stage: "idle",
      currentAction: null,
      lastRunCompletedAt: new Date(),
      lastRunDurationMs: Date.now() - cycleStartedAt,
      details: {
        source: input.source,
        traceId: cycleTraceId,
        replayedCount: replayedDecisions.length,
        feedbackCount: feedback.length,
        actionCount: actions.length,
        executedCount: executed.length,
        successCount: executed.filter((entry) => entry.success).length,
      },
    });

    logger.info(
      {
        companyId: input.companyId,
        source: input.source,
        feedbackCount: feedback.length,
        actionCount: actions.length,
        successCount: executed.filter((entry) => entry.success).length,
      },
      "Autonomous decision cycle completed",
    );

    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : "decision cycle failed";
    await setCycleState(db, input.companyId, "decision_engine", {
      status: "failed",
      stage: "idle",
      currentAction: null,
      lastError: message,
      lastRunCompletedAt: new Date(),
      lastRunDurationMs: Date.now() - cycleStartedAt,
      details: {
        source: input.source,
        traceId: cycleTraceId,
      },
    }).catch(() => undefined);
    throw err;
  }
}
