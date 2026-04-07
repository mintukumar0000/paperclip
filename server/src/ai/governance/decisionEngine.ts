import type { Db } from "@paperclipai/db";
import { and, eq, inArray } from "@paperclipai/db";
import { activityLog, issues } from "@paperclipai/db";
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

// STEP 2: Decision → Action bridge
// When the decision engine creates an issue, also trigger direct execution
// for action types that have automated handlers.
async function executeDirectAction(
  db: Db,
  companyId: string,
  action: DecisionAction,
): Promise<void> {
  const key = action.key;

  if (key === "increase_content_output" || key === "auto_scale_distribution") {
    try {
      const { _runTrafficCycleForTest } = await import("../../core/trafficLoop.js");
      const baseUrl = (
        process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL ??
        "http://localhost:3100"
      ).trim();
      logger.info({ companyId, key }, "Decision → Action: triggering traffic loop cycle");
      void _runTrafficCycleForTest({ db, baseUrl });
    } catch (err) {
      logger.warn({ err, key }, "Direct action execution failed for traffic trigger");
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
  }

  if (key === "payment_conversion_under_target" || key === "low_revenue_per_visitor") {
    logger.info({ companyId, key }, "Decision → Action: monetization optimization flagged");
    eventBus.publish("decision.direct_action", {
      companyId,
      actionKey: key,
      actionType: "monetization_optimization",
      timestamp: new Date().toISOString(),
    });
  }
}

export async function runAutonomousDecisionCycle(
  db: Db,
  input: DecisionCycleInput,
): Promise<DecisionCycleResult> {
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

  const actions = llmAdvice?.suggestedActions
    ? dedupeDecisionActions([...ruleActions, ...llmAdvice.suggestedActions])
    : ruleActions;

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
      executed.push({ action, success: result.success, details: result.details, error: result.error });

      // STEP 2: After creating an issue, also trigger direct execution
      if (result.success && !result.details?.skipped) {
        await executeDirectAction(db, input.companyId, action);
      }

      // STEP 4: Record action outcome in vector memory for learning
      await recordActionOutcome(db, input.companyId, action.key, result.success, {
        actionType: action.type,
        reason: action.reason,
        skipped: result.details?.skipped ?? false,
        source: input.source,
      }).catch(() => {});

      const issueId = typeof result.details?.issueId === "string" ? result.details.issueId : null;
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
          success: result.success,
          ...result.details,
          error: result.error ?? null,
        },
      });

      eventBus.publish("decision.action.executed", {
        companyId: input.companyId,
        source: input.source,
        actionType: action.type,
        key: action.key,
        success: result.success,
        details: result.details ?? null,
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
