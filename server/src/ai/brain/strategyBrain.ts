import type { Db } from "@paperclipai/db";
import { aiStrategyState, activityLog, eq, desc, and } from "@paperclipai/db";
import pino from "pino";
import { routeLLMJSON } from "../llmRouter.js";
import { buildMemoryContext } from "../../memory/embeddingMemory.js";
import { getTopSkills } from "../skills/skillStore.js";
import { buildSkillPromptBlock } from "../skills/applySkills.js";
import { getRecentSystemMetricsSnapshot } from "../feedback/metricsEngine.js";
import { eventBus } from "../../events/eventBus.js";
import { listScopedCompanyIds } from "../../core/companyScope.js";

const logger = pino({ name: "strategy-brain" });

export interface StrategyState {
  currentStrategy: string;
  beliefs: string[];
  hypotheses: string[];
  experiments: string[];
  lastMetrics: Record<string, unknown> | null;
  updatedAt: string;
}

async function getStrategyState(db: Db, companyId: string): Promise<StrategyState | null> {
  const rows = await db
    .select()
    .from(aiStrategyState)
    .where(eq(aiStrategyState.companyId, companyId))
    .limit(1);

  if (rows.length === 0) return null;

  const row = rows[0]!;
  return {
    currentStrategy: row.currentStrategy,
    beliefs: row.beliefs ?? [],
    hypotheses: row.hypotheses ?? [],
    experiments: row.activeExperiments ?? [],
    lastMetrics: row.lastMetricsSnapshot ?? null,
    updatedAt: row.updatedAt?.toISOString() ?? "",
  };
}

async function saveStrategyState(
  db: Db,
  companyId: string,
  state: {
    currentStrategy: string;
    beliefs: string[];
    hypotheses: string[];
    experiments: string[];
    lastMetrics: Record<string, unknown>;
  },
): Promise<void> {
  const existing = await db
    .select({ companyId: aiStrategyState.companyId })
    .from(aiStrategyState)
    .where(eq(aiStrategyState.companyId, companyId))
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(aiStrategyState)
      .set({
        currentStrategy: state.currentStrategy,
        beliefs: state.beliefs,
        hypotheses: state.hypotheses,
        activeExperiments: state.experiments,
        lastMetricsSnapshot: state.lastMetrics,
        updatedAt: new Date(),
      })
      .where(eq(aiStrategyState.companyId, companyId));
  } else {
    await db.insert(aiStrategyState).values({
      companyId,
      currentStrategy: state.currentStrategy,
      beliefs: state.beliefs,
      hypotheses: state.hypotheses,
      activeExperiments: state.experiments,
      lastMetricsSnapshot: state.lastMetrics,
    });
  }
}

export async function runStrategyBrainCycle(
  db: Db,
  companyId: string,
): Promise<StrategyState | null> {
  const metrics = await getRecentSystemMetricsSnapshot(db, companyId, 4320);
  const previousState = await getStrategyState(db, companyId);

  let memoryContext = "";
  try {
    memoryContext = await buildMemoryContext(db, companyId, "strategy revenue conversion what worked failed", 8);
  } catch { /* memory unavailable */ }

  const topSkills = await getTopSkills(db, companyId, 10);
  const skillBlock = buildSkillPromptBlock(topSkills);

  const recentActions = await db
    .select({ details: activityLog.details, createdAt: activityLog.createdAt })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "ai.decision.action.executed"),
      ),
    )
    .orderBy(desc(activityLog.createdAt))
    .limit(15);

  const actionSummary = recentActions
    .map((r) => {
      const d = (r.details ?? {}) as Record<string, unknown>;
      return `- [${d.actionType}] ${d.key}: ${d.reason ?? ""} (success=${d.success})`;
    })
    .join("\n");

  const result = await routeLLMJSON<{
    currentStrategy?: string;
    beliefs?: string[];
    hypotheses?: string[];
    experiments?: string[];
    weekly_priorities?: string[];
    kill_list?: string[];
  }>("strategy", [
    {
      role: "system",
      content: `You are the persistent CEO brain of an autonomous company. You are NOT an assistant — you ARE the founder. This company runs 24/7 without human intervention. You think in terms of weeks, not moments.

## Your Thinking Process

Step 1 — ASSESS: What changed since your last thinking cycle? Did beliefs hold? Did experiments produce results?
Step 2 — BELIEVE: Update your beliefs based on hard data. Drop beliefs that metrics disprove. Strengthen beliefs that data confirms.
Step 3 — HYPOTHESIZE: What's the single biggest bottleneck? Form one testable hypothesis about how to fix it.
Step 4 — PLAN: Set the strategic direction that ALL agents must follow. Be dictatorial — no ambiguity.
Step 5 — KILL: What should the company STOP doing? Identify waste.

## Rules

- Every belief MUST reference a specific metric or observation. "Reddit converts well" is weak. "Reddit r/SideProject posts with founder-story angles produce 13% CTR vs 3% for generic posts" is strong.
- Every hypothesis MUST have a clear success/failure criteria: "If we switch to $9 pricing and conversion stays above 3%, the hypothesis is confirmed."
- Every experiment MUST be measurable within 7 days.
- Your strategy must be ONE clear sentence that any agent can follow. Not a paragraph of hedging.
- Keep: max 5 beliefs, 3 hypotheses, 3 experiments.
- Add "weekly_priorities": top 3 things to do THIS WEEK in order.
- Add "kill_list": things to STOP doing (max 2).

Return JSON:
{
  "currentStrategy": "One sentence. Direct. Opinionated.",
  "beliefs": ["Data-backed belief with specific metric"],
  "hypotheses": ["Testable with clear success criteria"],
  "experiments": ["What we're testing + how we'll measure"],
  "weekly_priorities": ["Priority 1", "Priority 2", "Priority 3"],
  "kill_list": ["Thing to stop doing and why"]
}`,
    },
    {
      role: "user",
      content: `## Previous Strategy State
${previousState ? `Strategy: ${previousState.currentStrategy}
Beliefs: ${JSON.stringify(previousState.beliefs)}
Hypotheses: ${JSON.stringify(previousState.hypotheses)}
Experiments: ${JSON.stringify(previousState.experiments)}` : "No previous state — this is the first strategy cycle. Think from first principles."}

## Current Metrics
- Traffic: ${metrics.traffic}
- Conversions: ${metrics.conversions}
- Revenue: $${(metrics.revenue / 100).toFixed(2)}
- Conversion Rate: ${metrics.conversion_rate.toFixed(2)}%
- Payment Conversion: ${metrics.payment_conversion_rate.toFixed(2)}%
- Revenue per Visitor: ${metrics.revenue_per_visit.toFixed(2)}c
- Revenue per User: ${metrics.revenue_per_user.toFixed(2)}c
- Bounce Rate: ${metrics.bounce_rate.toFixed(1)}%

## Recent Actions & Results
${actionSummary || "No recent actions recorded"}

${memoryContext ? `## Memory Context\n${memoryContext}` : ""}

${skillBlock ? `\n${skillBlock}` : ""}

Update the strategy state. What should this company focus on? What do you believe? What should we test?`,
    },
  ]);

  if (!result) {
    logger.warn({ companyId }, "Strategy brain: LLM returned no result");
    return previousState;
  }

  const weeklyPriorities = Array.isArray(result.weekly_priorities) ? result.weekly_priorities.map(String) : [];
  const killList = Array.isArray(result.kill_list) ? result.kill_list.map(String) : [];

  const newState = {
    currentStrategy: result.currentStrategy ?? previousState?.currentStrategy ?? "",
    beliefs: result.beliefs ?? previousState?.beliefs ?? [],
    hypotheses: result.hypotheses ?? previousState?.hypotheses ?? [],
    experiments: result.experiments ?? previousState?.experiments ?? [],
    lastMetrics: {
      ...(metrics as unknown as Record<string, unknown>),
      weeklyPriorities,
      killList,
    },
  };

  await saveStrategyState(db, companyId, newState);

  await db.insert(activityLog).values({
    companyId,
    actorType: "system",
    actorId: "strategy-brain",
    agentId: null,
    runId: null,
    action: "strategy.brain.cycle.completed",
    entityType: "company",
    entityId: companyId,
    details: {
      strategy: newState.currentStrategy.slice(0, 300),
      beliefCount: newState.beliefs.length,
      hypothesisCount: newState.hypotheses.length,
      experimentCount: newState.experiments.length,
      weeklyPriorities,
      killList,
      changed: newState.currentStrategy !== previousState?.currentStrategy,
    },
  });

  eventBus.publish("strategy.brain.updated", {
    companyId,
    strategy: newState.currentStrategy.slice(0, 200),
    beliefs: newState.beliefs.length,
    timestamp: new Date().toISOString(),
  });

  logger.info(
    { companyId, beliefs: newState.beliefs.length, hypotheses: newState.hypotheses.length },
    "Strategy brain cycle completed",
  );

  return {
    ...newState,
    lastMetrics: newState.lastMetrics,
    updatedAt: new Date().toISOString(),
  };
}

export { getStrategyState };

let brainInterval: ReturnType<typeof setInterval> | null = null;

export function startStrategyBrain(db: Db, intervalMs = 6 * 60 * 60_000): () => void {
  const enabled = (process.env.STRATEGY_BRAIN_ENABLED ?? "true").trim().toLowerCase();
  if (enabled === "false" || enabled === "0") {
    logger.info("Strategy brain disabled");
    return () => {};
  }

  logger.info({ intervalMs }, "Starting strategy brain");

  setTimeout(async () => {
    try {
      const companyIds = await listScopedCompanyIds(db, { limit: 3 });
      for (const companyId of companyIds) {
        await runStrategyBrainCycle(db, companyId);
      }
    } catch (err) {
      logger.error({ err }, "Strategy brain initial cycle failed");
    }
  }, 4 * 60_000);

  brainInterval = setInterval(async () => {
    try {
      const companyIds = await listScopedCompanyIds(db, { limit: 3 });
      for (const companyId of companyIds) {
        await runStrategyBrainCycle(db, companyId);
      }
    } catch (err) {
      logger.error({ err }, "Strategy brain cycle failed");
    }
  }, intervalMs);

  return () => {
    if (brainInterval) {
      clearInterval(brainInterval);
      brainInterval = null;
    }
  };
}
