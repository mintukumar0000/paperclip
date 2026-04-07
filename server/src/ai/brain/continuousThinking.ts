import type { Db } from "@paperclipai/db";
import { activityLog } from "@paperclipai/db";
import { desc, eq } from "@paperclipai/db";
import pino from "pino";
import { routeLLMJSON } from "../llmRouter.js";
import { getStrategyState } from "./strategyBrain.js";
import { getRecentSystemMetricsSnapshot } from "../feedback/metricsEngine.js";
import { buildMemoryContext } from "../../memory/embeddingMemory.js";
import { getTopSkills } from "../skills/skillStore.js";
import { buildSkillPromptBlock } from "../skills/applySkills.js";
import { eventBus } from "../../events/eventBus.js";
import { executeActions, type ExecutionAction, checkAndScaleWinners } from "../execution/autonomousExecutor.js";
import { getActiveCompanyId, listScopedCompanyIds } from "../../core/companyScope.js";

const logger = pino({ name: "continuous-thinking" });

interface MicroDecision {
  bottleneck: string;
  highest_leverage_action: string;
  action_type: string;
  confidence: number;
  stop_doing: string;
  rpv_assessment: string;
}

async function getPreferredCompanyId(db: Db): Promise<string | null> {
  const scopedCompanyId = getActiveCompanyId();
  if (scopedCompanyId) return scopedCompanyId;

  const billingCompanyId = (process.env.BILLING_WEBHOOK_COMPANY_ID ?? "").trim();
  if (billingCompanyId) return billingCompanyId;

  const companyIds = await listScopedCompanyIds(db, { limit: 1 });
  return companyIds[0] ?? null;
}

async function getRecentActions(db: Db, companyId: string, limit = 10): Promise<string> {
  const rows = await db
    .select({ action: activityLog.action, details: activityLog.details, createdAt: activityLog.createdAt })
    .from(activityLog)
    .where(eq(activityLog.companyId, companyId))
    .orderBy(desc(activityLog.createdAt))
    .limit(limit);

  if (rows.length === 0) return "No recent actions.";

  return rows
    .map((r) => `[${new Date(r.createdAt).toISOString().slice(0, 16)}] ${r.action}: ${JSON.stringify(r.details ?? {}).slice(0, 120)}`)
    .join("\n");
}

async function runThinkingCycle(db: Db): Promise<void> {
  const companyId = await getPreferredCompanyId(db);
  if (!companyId) {
    logger.debug("No company found for thinking loop");
    return;
  }

  let metrics;
  try {
    metrics = await getRecentSystemMetricsSnapshot(db, companyId, 60);
  } catch {
    logger.debug("Metrics unavailable for thinking loop");
    return;
  }

  const strategyState = await getStrategyState(db, companyId);
  const recentActions = await getRecentActions(db, companyId, 8);

  let memoryContext = "";
  try {
    memoryContext = await buildMemoryContext(db, companyId, "bottleneck revenue conversion what worked", 5);
  } catch { /* memory unavailable */ }

  let skillBlock = "";
  try {
    const skills = await getTopSkills(db, companyId, 5);
    skillBlock = buildSkillPromptBlock(skills);
  } catch { /* skills unavailable */ }

  const rpv = metrics.traffic > 0 ? (metrics.revenue / metrics.traffic).toFixed(2) : "0";
  const signupRate = metrics.traffic > 0 ? ((metrics.conversions / metrics.traffic) * 100).toFixed(1) : "0";
  const paymentRate = metrics.conversions > 0 ? ((metrics.payment_conversions / metrics.conversions) * 100).toFixed(1) : "0";

  const systemPrompt = `You are the always-on CEO brain of an autonomous company.
You run every 15 minutes. Be DECISIVE. No hedging, no "it depends."

Your SOLE OBJECTIVE: maximize Revenue Per Visitor (RPV).

RPV = revenue / visitors. Currently: ${rpv} cents/visitor.

Rules:
- Pick ONE action only. The highest-leverage move RIGHT NOW.
- If something works (CTR > 5%, signup > 15%, payment > 3%), SCALE IT immediately.
- If something fails (CTR < 0.5%, signup < 1%, payment < 0.5%), KILL IT immediately.
- Never suggest "monitor" or "analyze more" — always choose an ACTION.
- Your action_type must be one of: scale_traffic, kill_channel, improve_landing, improve_pricing, improve_email, improve_offer, switch_audience, create_content, pause_spending

${skillBlock}`;

  const userContent = `CURRENT STATE (real-time):
- Traffic: ${metrics.traffic} visitors
- Signups: ${metrics.conversions} (${signupRate}%)
- Payments: ${metrics.payment_conversions} (${paymentRate}% of signups)
- Revenue: ${metrics.revenue} cents
- RPV: ${rpv} cents/visitor
- Task success: ${(metrics.task_success_rate * 100).toFixed(0)}%

STRATEGY:
${strategyState?.currentStrategy || "No strategy set"}

BELIEFS:
${strategyState?.beliefs?.slice(0, 3).join("\n") || "None"}

RECENT ACTIONS:
${recentActions}

MEMORY:
${memoryContext || "No memory available"}

RESPOND IN STRICT JSON:
{
  "bottleneck": "the single biggest bottleneck right now",
  "highest_leverage_action": "the specific action to take",
  "action_type": "one of: scale_traffic|kill_channel|improve_landing|improve_pricing|improve_email|improve_offer|switch_audience|create_content|pause_spending",
  "confidence": 0.0-1.0,
  "stop_doing": "one thing to stop doing immediately",
  "rpv_assessment": "one sentence on why this action will increase RPV"
}`;

  const decision = await routeLLMJSON<MicroDecision>("decision", [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent },
  ]);

  if (!decision) {
    logger.debug("Thinking loop: LLM unavailable or no response");
    return;
  }

  logger.info(
    { bottleneck: decision.bottleneck, action: decision.highest_leverage_action, confidence: decision.confidence, actionType: decision.action_type },
    "Micro-decision made",
  );

  await eventBus.publish("thinking.micro_decision", {
    companyId,
    decision,
    timestamp: new Date().toISOString(),
  });

  // Check for immediate scaling opportunity
  await checkAndScaleWinners(db, companyId, {
    ctr: metrics.traffic > 0 ? metrics.conversions / metrics.traffic : 0,
    signupRate: metrics.traffic > 0 ? metrics.conversions / metrics.traffic : 0,
    paymentRate: metrics.conversions > 0 ? metrics.payment_conversions / metrics.conversions : 0,
  });

  const ACTION_TYPE_TO_KEY: Record<string, string> = {
    scale_traffic: "auto_scale_distribution",
    kill_channel: "kill_underperformer",
    improve_landing: "improve_landing_page",
    improve_pricing: "optimize_pricing",
    improve_email: "improve_email_sequence",
    improve_offer: "improve_offer_framing",
    switch_audience: "audience_repositioning",
    create_content: "increase_content_output",
    pause_spending: "pause_spending",
  };

  if (decision.confidence >= 0.7 && decision.action_type) {
    const actionKey = ACTION_TYPE_TO_KEY[decision.action_type] ?? decision.action_type;

    const executionAction: ExecutionAction = {
      key: actionKey,
      type: decision.action_type,
      reasoning: `[Micro-decision] ${decision.highest_leverage_action} — RPV: ${decision.rpv_assessment}`,
      priority: decision.confidence >= 0.85 ? "high" : "medium",
      expectedImpact: decision.rpv_assessment,
      confidence: decision.confidence,
      source: "continuous-thinking",
    };

    await executeActions(db, companyId, [executionAction]);

    await eventBus.publish("thinking.action.triggered", {
      companyId,
      actionKey,
      confidence: decision.confidence,
      reasoning: decision.highest_leverage_action,
    });
  }
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
