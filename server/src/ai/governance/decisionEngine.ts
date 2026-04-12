import type { Db } from "@paperclipai/db";
import { and, eq, inArray } from "@paperclipai/db";
import { activityLog, companies, issues } from "@paperclipai/db";
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

const logger = pino({ name: "decision-engine" });

export type DecisionActionType = "create_issue" | "update_strategy" | "trigger_expansion";

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

  if (key === "increase_content_output" || key === "auto_scale_distribution") {
    try {
      const { _runTrafficCycleForTest } = await import("../../core/trafficLoop.js");
      const baseUrl = (
        process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL ??
        "http://localhost:3100"
      ).trim();
      logger.info({ companyId, key }, "Decision → Action: triggering traffic loop cycle");
      const summary = await _runTrafficCycleForTest({ db, baseUrl });
      return {
        attempted: true,
        success: summary.successCount > 0,
        details: {
          successCount: summary.successCount,
          failCount: summary.failCount,
          error: summary.error ?? null,
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

  const ruleActions = mapFeedbackToDecisionActions(input.companyId, feedback, input.metrics);

  // STEP 3: LLM Decision Intelligence Layer
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

  const currentRpv = currentRPVCents(input.metrics);
  const rpvMode = selectRpvExecutionMode(input.metrics);
  const actions = proposedActions.filter((action) => {
    if (rpvMode === "exploration") return true;
    if (rpvMode === "validation") return !rejectActionInValidationMode(action, currentRpv);
    return !rejectAction(action, currentRpv);
  });
  const rejectedByRpv = proposedActions.filter((action) => {
    if (rpvMode === "exploration") return false;
    if (rpvMode === "validation") return rejectActionInValidationMode(action, currentRpv);
    return rejectAction(action, currentRpv);
  });

  if (rpvMode === "exploration") {
    await db.insert(activityLog).values({
      companyId: input.companyId,
      actorType: "system",
      actorId: "decision-engine",
      agentId: null,
      runId: null,
      action: "ai.decision.rpv_gate.bypassed",
      entityType: "company",
      entityId: input.companyId,
      details: {
        source: input.source,
        revenue: input.metrics.revenue,
        traffic: input.metrics.traffic,
        reason: "early_stage_zero_revenue",
      },
    });
  }

  await db.insert(activityLog).values({
    companyId: input.companyId,
    actorType: "system",
    actorId: "decision-engine",
    agentId: null,
    runId: null,
    action: "ai.decision.rpv_gate.mode",
    entityType: "company",
    entityId: input.companyId,
    details: {
      source: input.source,
      mode: rpvMode,
      revenue: input.metrics.revenue,
      traffic: input.metrics.traffic,
      currentRpv,
      validationThresholdCents: getValidationRevenueThresholdCents(),
      proposedCount: proposedActions.length,
      allowedCount: actions.length,
      rejectedCount: rejectedByRpv.length,
    },
  });

  if (rejectedByRpv.length > 0) {
    await db.insert(activityLog).values({
      companyId: input.companyId,
      actorType: "system",
      actorId: "decision-engine",
      agentId: null,
      runId: null,
      action: "ai.decision.action.rejected.rpv",
      entityType: "company",
      entityId: input.companyId,
      details: {
        source: input.source,
        mode: rpvMode,
        currentRpv,
        rejectedCount: rejectedByRpv.length,
        rejectedKeys: rejectedByRpv.map((entry) => entry.key),
      },
    });
  }

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
      },
    });
  }

  const executed: DecisionCycleResult["executed"] = [];
  for (const action of actions) {
    try {
      const result = await executeAction(db, input.companyId, action);
      const details: Record<string, unknown> = result.details ? { ...result.details } : {};
      const issueId = typeof details.issueId === "string" ? details.issueId : null;
      const skipped = details.skipped === true;

      if (skipped) {
        const fallbackReason = typeof details.reason === "string" ? details.reason : "skipped";
        const fallback = await createFallbackForSkippedAction(db, input.companyId, action, fallbackReason);
        if (fallback) {
          details.fallback = fallback;
          details.fallbackTriggered = true;
        }
      }

      // STEP 2: After creating an issue, also trigger direct execution
      if (result.success && !skipped) {
        const direct = await executeDirectAction(db, input.companyId, action);
        details.directExecution = direct;

        if (issueId && direct.success) {
          await issueService(db).update(issueId, { status: "done" });
          details.issueCompleted = true;
          await db.insert(activityLog).values({
            companyId: input.companyId,
            actorType: "system",
            actorId: "decision-engine",
            agentId: null,
            runId: null,
            action: "ai.decision.action.completed",
            entityType: "issue",
            entityId: issueId,
            details: {
              source: input.source,
              key: action.key,
              reason: "direct_execution_success",
            },
          });
        }
      }

      const completed = !skipped && (details.issueCompleted === true || action.type !== "create_issue");
      details.completed = completed;
      const successForTelemetry = result.success && !skipped;

      executed.push({ action, success: successForTelemetry, details, error: result.error });

      // STEP 4: Record action outcome in vector memory for learning
      await recordActionOutcome(db, input.companyId, action.key, successForTelemetry, {
        actionType: action.type,
        reason: action.reason,
        skipped,
        source: input.source,
      }).catch(() => {});

      await db.insert(activityLog).values({
        companyId: input.companyId,
        actorType: "system",
        actorId: "decision-engine",
        agentId: null,
        runId: null,
        action: "ai.decision.action.executed",
        entityType: issueId ? "issue" : "company",
        entityId: issueId ?? input.companyId,
        details: {
          source: input.source,
          actionType: action.type,
          key: action.key,
          reason: action.reason,
          success: successForTelemetry,
          ...details,
          error: result.error ?? null,
        },
      });

      eventBus.publish("decision.action.executed", {
        companyId: input.companyId,
        source: input.source,
        actionType: action.type,
        key: action.key,
        success: successForTelemetry,
        details: details,
        error: result.error ?? null,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Action execution failed";
      executed.push({ action, success: false, error: message });
      logger.error({ err, companyId: input.companyId, action }, "Decision action failed");
    }
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
    timestamp: new Date().toISOString(),
  });

  await db.insert(activityLog).values({
    companyId: input.companyId,
    actorType: "system",
    actorId: "decision-engine",
    agentId: null,
    runId: null,
    action: "ai.decision.cycle.completed",
    entityType: "company",
    entityId: input.companyId,
    details: {
      source: input.source,
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
}
