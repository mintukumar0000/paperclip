// ---------------------------------------------------------------------------
// Company Execution Loop — heartbeat-driven autonomous AI company engine
// ---------------------------------------------------------------------------
//
// Runs every heartbeat:
//   1. Load active goals across the company
//   2. For each goal, load the plan + pick the next executable step
//   3. Execute the step via the AI executor / adapter router
//   4. Observe the result
//   5. Update the plan + store episodic memory
//   6. Repeat until all goals are done or cancelled
//
// This is the "AutoGPT / Devin loop" for production.
// ---------------------------------------------------------------------------

import type { Db } from "@paperclipai/db";
import { agentPlans, agents, issues } from "@paperclipai/db";
import { eq, and, inArray } from "@paperclipai/db";
import { randomUUID } from "node:crypto";
import type { AIExecutionContext } from "../types.js";
import {
  type TaskGraph,
  getReadySteps,
  markStepRunning,
  markStepCompleted,
  markStepFailed,
  resetStepForRetry,
  isGraphComplete,
  isGraphStuck,
  getGraphProgress,
} from "../planning/taskGraph.js";
import { generateExecutableStep, collectPreviousOutputs } from "../planning/stepGenerator.js";
import { observe, type Observation } from "../loop/observationEngine.js";
import { replan } from "../loop/replanner.js";
import { executeAI } from "../executor.js";
import { planStore } from "../memory/planStore.js";
import { episodicMemory } from "../memory/episodicMemory.js";
import { recordSystemMetric, estimateTokenCostCents } from "../feedback/metricsEngine.js";
import { publishEvent } from "../../events/eventPublisher.js";
import { getAutonomyLimits } from "../governance/autonomyLimits.js";
import { getActiveCompanyId } from "../../core/companyScope.js";
import pino from "pino";

const logger = pino({ name: "company-execution-loop" });

const STEP_TIMEOUT_MS = 120_000; // 2 minutes per step

// Mutual exclusion — prevent double-execution of the same plan
const _runningPlanIds = new Set<string>();

export interface CompanyLoopResult {
  goalsProcessed: number;
  stepsExecuted: number;
  goalsCompleted: number;
  goalsFailed: number;
  errors: string[];
}

/**
 * Execute one tick of the company execution loop.
 * Called every heartbeat — finds active goals, executes their next step,
 * observes, updates, and moves on.
 */
export async function companyExecutionLoop(
  db: Db,
  companyId?: string,
): Promise<CompanyLoopResult> {
  const store = planStore(db);
  const episodic = episodicMemory(db);
  const result: CompanyLoopResult = {
    goalsProcessed: 0,
    stepsExecuted: 0,
    goalsCompleted: 0,
    goalsFailed: 0,
    errors: [],
  };

  // 1. Load active goals
  const whereClause = companyId
    ? and(eq(agentPlans.status, "active"))
    : eq(agentPlans.status, "active");

  let activePlans;
  if (companyId) {
    activePlans = await db
      .select()
      .from(agentPlans)
      .where(and(eq(agentPlans.status, "active"), eq(agentPlans.companyId, companyId)));
  } else {
    activePlans = await db
      .select()
      .from(agentPlans)
      .where(eq(agentPlans.status, "active"));
  }

  if (activePlans.length === 0) {
    return result;
  }

  // Enforce active plan cap — prevent unbounded plan accumulation
  const limits = getAutonomyLimits();
  const planCap = limits.maxActivePlansPerCompany;
  const plansToProcess = activePlans.slice(0, planCap);

  if (activePlans.length > planCap) {
    logger.warn(
      { companyId: companyId ?? "all", activePlans: activePlans.length, cap: planCap },
      "Active plans exceed cap — only processing first batch, excess plans deferred",
    );
    result.errors.push(`Active plans (${activePlans.length}) exceed cap (${planCap}) — excess deferred`);
  }

  logger.info(
    { activeGoals: plansToProcess.length, companyId: companyId ?? "all" },
    "Company loop tick — processing active goals",
  );

  // 2. For each goal, process one step
  for (const plan of plansToProcess) {
    // Mutual exclusion — skip plans already being executed
    if (_runningPlanIds.has(plan.id)) {
      logger.debug({ planId: plan.id }, "Plan already running, skipping");
      continue;
    }

    result.goalsProcessed++;
    _runningPlanIds.add(plan.id);

    try {
      const stepResult = await processGoalStep(db, plan, store, episodic);

      if (stepResult.stepExecuted) result.stepsExecuted++;
      if (stepResult.goalCompleted) result.goalsCompleted++;
      if (stepResult.goalFailed) result.goalsFailed++;

    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      result.errors.push(`Goal ${plan.id}: ${msg}`);
      logger.error({ err, planId: plan.id }, "Error processing goal step");
    } finally {
      _runningPlanIds.delete(plan.id);
    }
  }

  logger.info(
    {
      goalsProcessed: result.goalsProcessed,
      stepsExecuted: result.stepsExecuted,
      goalsCompleted: result.goalsCompleted,
      goalsFailed: result.goalsFailed,
      errors: result.errors.length,
    },
    "Company loop tick completed",
  );

  return result;
}

// -------------------------------------------------------------------------
// Internal — process a single step for a single goal
// -------------------------------------------------------------------------

interface StepResult {
  stepExecuted: boolean;
  goalCompleted: boolean;
  goalFailed: boolean;
}

async function processGoalStep(
  db: Db,
  plan: typeof agentPlans.$inferSelect,
  store: ReturnType<typeof planStore>,
  episodic: ReturnType<typeof episodicMemory>,
): Promise<StepResult> {
  // Rebuild the task graph from persisted JSON
  const graph = plan.graphJson as unknown as TaskGraph;
  if (!graph || !graph.steps) {
    await store.updatePlanStatus(plan.id, "failed", "Invalid graph data");
    return { stepExecuted: false, goalCompleted: false, goalFailed: true };
  }

  // Check if already complete
  if (isGraphComplete(graph)) {
    await store.updatePlanStatus(plan.id, "completed");

    await publishEvent("ai.goal.completed", {
      planId: plan.id,
      companyId: plan.companyId,
      agentId: plan.agentId,
      goal: plan.goal,
    });

    return { stepExecuted: false, goalCompleted: true, goalFailed: false };
  }

  // Check if stuck
  if (isGraphStuck(graph)) {
    await store.updatePlanStatus(plan.id, "failed", "Plan is stuck — no executable steps");

    await publishEvent("ai.goal.failed", {
      planId: plan.id,
      companyId: plan.companyId,
      agentId: plan.agentId,
      error: "stuck",
    });

    return { stepExecuted: false, goalCompleted: false, goalFailed: true };
  }

  // Check iteration budget
  if (plan.iterationsUsed >= plan.maxIterations) {
    await store.updatePlanStatus(plan.id, "failed", "Max iterations exceeded");

    await publishEvent("ai.goal.failed", {
      planId: plan.id,
      companyId: plan.companyId,
      agentId: plan.agentId,
      error: "max_iterations",
    });

    return { stepExecuted: false, goalCompleted: false, goalFailed: true };
  }

  // Get next ready step
  const readySteps = getReadySteps(graph);
  if (readySteps.length === 0) {
    return { stepExecuted: false, goalCompleted: false, goalFailed: false };
  }

  const step = readySteps[0];

  // Build execution context
  const context = await buildContextForPlan(db, plan);
  if (!context) {
    await store.updatePlanStatus(plan.id, "failed", "Could not build execution context");
    return { stepExecuted: false, goalCompleted: false, goalFailed: true };
  }

  // Mark step running
  let currentGraph = markStepRunning(graph, step.id);

  await publishEvent("ai.step.started", {
    planId: plan.id,
    stepId: step.id,
    stepName: step.name,
    companyId: plan.companyId,
    agentId: plan.agentId,
  });

  // Generate executable context for this step
  const completedSteps = currentGraph.steps.filter((s) => s.status === "completed");
  const previousOutputs = collectPreviousOutputs(completedSteps);
  const executable = generateExecutableStep(step, context, previousOutputs);

  // Execute with per-step timeout protection
  let aiResult;
  try {
    aiResult = await Promise.race([
      executeAI(executable.context, db),
      new Promise<{ status: "failed"; error: string }>((_, reject) =>
        setTimeout(() => reject(new Error(`Step timeout after ${STEP_TIMEOUT_MS / 1000}s`)), STEP_TIMEOUT_MS),
      ),
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Execution error";
    aiResult = { status: "failed" as const, error: message };
  }

  // Observe
  const observation = observe(step, aiResult);

  try {
    const usage = (aiResult as { usage?: { inputTokens: number; outputTokens: number } }).usage;
    const success = observation.verdict === "success";
    await recordSystemMetric(db, {
      companyId: plan.companyId,
      sourceType: "task_execution",
      sourceId: `${plan.id}:${step.id}:${plan.iterationsUsed + 1}`,
      traffic: 1,
      conversions: success ? 1 : 0,
      revenueCents: 0,
      taskSuccessRate: success ? 1 : 0,
      costPerActionCents: estimateTokenCostCents(usage),
      metadata: {
        planId: plan.id,
        stepId: step.id,
        verdict: observation.verdict,
        agentId: plan.agentId,
      },
    });
  } catch (metricErr) {
    logger.warn({ err: metricErr, planId: plan.id, stepId: step.id }, "Failed to log task execution metric");
  }

  // Handle verdict
  switch (observation.verdict) {
    case "success":
      currentGraph = markStepCompleted(currentGraph, step.id, (aiResult as { output?: string }).output);

      await publishEvent("ai.step.completed", {
        planId: plan.id,
        stepId: step.id,
        companyId: plan.companyId,
        agentId: plan.agentId,
      });
      break;

    case "retry":
      currentGraph = markStepFailed(currentGraph, step.id, observation.error ?? "");
      currentGraph = resetStepForRetry(currentGraph, step.id);
      break;

    case "replan": {
      currentGraph = markStepFailed(currentGraph, step.id, observation.error ?? "");
      const replanResult = await replan({
        graph: currentGraph,
        observation,
        context,
      });
      if (replanResult.replanned) {
        currentGraph = replanResult.graph;
      }
      break;
    }

    case "guarded":
      currentGraph = markStepFailed(currentGraph, step.id, "Action guarded");
      break;

    case "abort":
      currentGraph = markStepFailed(currentGraph, step.id, observation.error ?? "");
      await store.updatePlanStatus(plan.id, "failed", observation.error ?? "Aborted");

      await publishEvent("ai.step.failed", {
        planId: plan.id,
        stepId: step.id,
        companyId: plan.companyId,
        agentId: plan.agentId,
        error: observation.error,
      });

      return { stepExecuted: true, goalCompleted: false, goalFailed: true };
  }

  // Record episode
  await episodic.recordEpisode({
    planId: plan.id,
    stepId: step.id,
    action: step.name,
    observation,
  });

  // Persist updated graph
  const progress = getGraphProgress(currentGraph);
  await store.updatePlanGraph(plan.id, currentGraph, {
    stepsCompleted: progress.completed,
    iterationsUsed: plan.iterationsUsed + 1,
    currentStep: currentGraph.steps.find((s) => s.status === "running")?.id,
  });

  // Check if goal just completed
  if (isGraphComplete(currentGraph)) {
    await store.updatePlanStatus(plan.id, "completed");

    await episodic.recordPlanSummary({
      planId: plan.id,
      companyId: plan.companyId,
      agentId: plan.agentId,
      goal: plan.goal,
      graph: currentGraph,
      success: true,
      totalIterations: plan.iterationsUsed + 1,
    });

    await publishEvent("ai.goal.completed", {
      planId: plan.id,
      companyId: plan.companyId,
      agentId: plan.agentId,
      goal: plan.goal,
      iterations: plan.iterationsUsed + 1,
    });

    return { stepExecuted: true, goalCompleted: true, goalFailed: false };
  }

  return { stepExecuted: true, goalCompleted: false, goalFailed: false };
}

// -------------------------------------------------------------------------
// Build AIExecutionContext from a plan row
// -------------------------------------------------------------------------

async function buildContextForPlan(
  db: Db,
  plan: typeof agentPlans.$inferSelect,
): Promise<AIExecutionContext | null> {
  const [agent] = await db.select().from(agents).where(eq(agents.id, plan.agentId));
  if (!agent) {
    logger.warn({ planId: plan.id, agentId: plan.agentId }, "Agent not found for plan");
    return null;
  }

  let issue = null;
  if (plan.issueId) {
    const rows = await db.select().from(issues).where(eq(issues.id, plan.issueId));
    issue = rows[0] ?? null;
  }

  // Load episodic memory for learned context
  const episodes = Array.isArray(plan.episodicJson) ? plan.episodicJson : [];
  const memoryContext = episodes.length > 0
    ? (episodes as any[]).map((e) => `[${e.action ?? "step"}] ${e.observation?.verdict ?? "unknown"}`).join("; ")
    : undefined;

  return {
    runId: randomUUID(),
    agent: {
      id: agent.id,
      companyId: agent.companyId,
      name: agent.name,
      role: (agent.adapterConfig as any)?.role,
      runtime: (agent.adapterConfig as any)?.aiRuntime ?? "openai",
      adapterConfig: agent.adapterConfig as Record<string, unknown> | undefined,
    },
    issue: issue
      ? {
          id: issue.id,
          title: issue.title,
          description: issue.description ?? undefined,
          status: issue.status ?? undefined,
        }
      : { id: plan.issueId ?? "", title: plan.goal },
    memoryContext,
  };
}

// -------------------------------------------------------------------------
// Scheduler integration
// -------------------------------------------------------------------------

let _schedulerTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the company execution loop on a periodic timer.
 * Returns a cleanup function.
 */
export function startCompanyLoop(db: Db, intervalMs = 30_000): () => void {
  const scopedCompanyId = getActiveCompanyId() ?? undefined;
  logger.info({ intervalMs, scopedCompanyId: scopedCompanyId ?? "all" }, "Starting company execution loop");

  _schedulerTimer = setInterval(() => {
    companyExecutionLoop(db, scopedCompanyId).catch((err) => {
      logger.error({ err }, "Company execution loop tick error");
    });
  }, intervalMs);

  return () => {
    if (_schedulerTimer) {
      clearInterval(_schedulerTimer);
      _schedulerTimer = null;
      logger.info("Company execution loop stopped");
    }
  };
}
