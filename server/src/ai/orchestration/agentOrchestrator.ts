// ---------------------------------------------------------------------------
// Agent Orchestrator — coordinates autonomous plan lifecycle
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import type { AIExecutionContext } from "../types.js";
import { generatePlan, generateDeterministicPlan } from "../planning/goalPlanner.js";
import { getGraphProgress } from "../planning/taskGraph.js";
import { runExecutionLoop, type LoopResult } from "../loop/executionLoop.js";
import { planStore } from "../memory/planStore.js";
import { episodicMemory } from "../memory/episodicMemory.js";
import { publishEvent } from "../../events/eventPublisher.js";
import pino from "pino";

const logger = pino({ name: "agent-orchestrator" });

// Track running plans to prevent double-execution
const runningPlans = new Map<string, AbortController>();

export interface GoalRequest {
  companyId: string;
  agentId: string;
  issueId: string;
  goal: string;
  context: AIExecutionContext;
  maxSteps?: number;
  maxIterations?: number;
  deterministic?: boolean;
  deterministicSteps?: Array<{
    name: string;
    description: string;
    dependsOn?: string[];
    toolName?: string;
    toolArgs?: Record<string, unknown>;
  }>;
}

export interface GoalResult {
  planId: string;
  status: string;
  iterations: number;
  stepsCompleted: number;
  stepsTotal: number;
  error?: string;
}

export function agentOrchestrator(db: Db) {
  const store = planStore(db);
  const episodic = episodicMemory(db);

  return {
    /** Create and execute a goal — the primary entry point */
    async executeGoal(request: GoalRequest): Promise<GoalResult> {
      const { companyId, agentId, issueId, goal, context } = request;

      logger.info({ companyId, agentId, goal }, "Goal execution requested");

      // 1. Generate the plan
      let graph;
      let reasoning = "";

      if (request.deterministic && request.deterministicSteps) {
        graph = generateDeterministicPlan(goal, request.deterministicSteps);
        reasoning = "Deterministic plan from predefined steps";
      } else {
        const planResult = await generatePlan({
          goal,
          context,
          maxSteps: request.maxSteps ?? 10,
        });
        graph = planResult.graph;
        reasoning = planResult.reasoning;
      }

      // 2. Persist the plan
      const plan = await store.createPlan({
        companyId,
        agentId,
        issueId,
        goal,
        graph,
        maxIterations: request.maxIterations ?? 25,
      });

      await store.updatePlanStatus(plan.id, "active");

      await publishEvent("ai.execution.started" as any, {
        planId: plan.id,
        agentId,
        companyId,
        goal,
        reasoning,
        totalSteps: graph.steps.length,
      });

      // 3. Create cancellation controller
      const controller = new AbortController();
      runningPlans.set(plan.id, controller);

      // 4. Run the execution loop
      let loopResult: LoopResult;
      try {
        loopResult = await runExecutionLoop(graph, context, db, {
          maxIterations: request.maxIterations ?? 25,
          shouldCancel: () => controller.signal.aborted,
          onStepComplete: async (stepId, observation) => {
            await episodic.recordEpisode({
              planId: plan.id,
              stepId,
              action: observation.stepId,
              observation,
            });
          },
          onGraphUpdate: async (updatedGraph) => {
            const progress = getGraphProgress(updatedGraph);
            await store.updatePlanGraph(plan.id, updatedGraph, {
              stepsCompleted: progress.completed,
              iterationsUsed: progress.completed + progress.failed,
              currentStep: updatedGraph.steps.find((s) => s.status === "running")?.id,
            });
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Execution loop error";
        logger.error({ err, planId: plan.id }, "Execution loop threw");
        await store.updatePlanStatus(plan.id, "failed", message);
        runningPlans.delete(plan.id);
        return {
          planId: plan.id,
          status: "failed",
          iterations: 0,
          stepsCompleted: 0,
          stepsTotal: graph.steps.length,
          error: message,
        };
      } finally {
        runningPlans.delete(plan.id);
      }

      // 5. Finalize
      const finalStatus = loopResult.status === "completed" ? "completed" : "failed";
      await store.updatePlanStatus(
        plan.id,
        finalStatus as any,
        loopResult.error,
      );

      const progress = getGraphProgress(loopResult.graph);

      // 6. Record plan summary in episodic memory
      await episodic.recordPlanSummary({
        planId: plan.id,
        companyId,
        agentId,
        goal,
        graph: loopResult.graph,
        success: finalStatus === "completed",
        totalIterations: loopResult.iterations,
      });

      await publishEvent("ai.execution.completed" as any, {
        planId: plan.id,
        agentId,
        companyId,
        status: finalStatus,
        iterations: loopResult.iterations,
        stepsCompleted: progress.completed,
        stepsTotal: progress.total,
      });

      logger.info(
        { planId: plan.id, status: finalStatus, iterations: loopResult.iterations, progress },
        "Goal execution finished",
      );

      return {
        planId: plan.id,
        status: finalStatus,
        iterations: loopResult.iterations,
        stepsCompleted: progress.completed,
        stepsTotal: progress.total,
        error: loopResult.error,
      };
    },

    /** Cancel a running goal */
    cancelGoal(planId: string) {
      const controller = runningPlans.get(planId);
      if (controller) {
        controller.abort();
        logger.info({ planId }, "Goal cancellation requested");
        return true;
      }
      return false;
    },

    /** List goals for a company */
    async listGoals(companyId: string, opts?: { agentId?: string; status?: string; limit?: number }) {
      return store.listPlans(companyId, opts as any);
    },

    /** Get a specific goal/plan */
    async getGoal(planId: string, companyId: string) {
      return store.getPlanScoped(planId, companyId);
    },

    /** Check if a goal is currently running */
    isGoalRunning(planId: string): boolean {
      return runningPlans.has(planId);
    },
  };
}
