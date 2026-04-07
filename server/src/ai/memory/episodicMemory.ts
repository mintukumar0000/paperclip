// ---------------------------------------------------------------------------
// Episodic Memory — records agent experiences for learning across plans
// ---------------------------------------------------------------------------

import type { Db } from "@paperclipai/db";
import { memoryService } from "../../memory/memoryService.js";
import { planStore } from "./planStore.js";
import type { Observation } from "../loop/observationEngine.js";
import type { TaskGraph } from "../planning/taskGraph.js";
import { getGraphProgress } from "../planning/taskGraph.js";
import pino from "pino";

const logger = pino({ name: "episodic-memory" });

export interface Episode {
  timestamp: string;
  planId: string;
  stepId: string;
  action: string;
  verdict: string;
  output?: string;
  error?: string;
  lesson?: string;
}

export function episodicMemory(db: Db) {
  const memories = memoryService(db);
  const plans = planStore(db);

  return {
    /** Record a step execution episode */
    async recordEpisode(params: {
      planId: string;
      stepId: string;
      action: string;
      observation: Observation;
    }): Promise<Episode> {
      const episode: Episode = {
        timestamp: new Date().toISOString(),
        planId: params.planId,
        stepId: params.stepId,
        action: params.action,
        verdict: params.observation.verdict,
        output: params.observation.output,
        error: params.observation.error,
      };

      // Derive a lesson from failures
      if (params.observation.verdict === "retry" || params.observation.verdict === "replan") {
        episode.lesson = `Step "${params.action}" failed with: ${params.observation.error ?? "unknown error"}. Consider alternative approaches.`;
      }

      // Persist to plan's episodic json
      await plans.appendEpisodic(params.planId, episode as unknown as Record<string, unknown>);

      logger.debug(
        { planId: params.planId, stepId: params.stepId, verdict: episode.verdict },
        "Episode recorded",
      );

      return episode;
    },

    /** Record a plan completion summary as a structured memory */
    async recordPlanSummary(params: {
      planId: string;
      companyId: string;
      agentId: string;
      goal: string;
      graph: TaskGraph;
      success: boolean;
      totalIterations: number;
    }) {
      const progress = getGraphProgress(params.graph);
      const summary = [
        `Goal: ${params.goal}`,
        `Result: ${params.success ? "SUCCESS" : "FAILED"}`,
        `Steps: ${progress.completed}/${progress.total} completed`,
        `Iterations: ${params.totalIterations}`,
        `Failed steps: ${progress.failed}`,
      ].join("\n");

      await memories.storeMemory({
        companyId: params.companyId,
        agentId: params.agentId,
        type: params.success ? "knowledge" : "experiment",
        title: `Plan: ${params.goal}`,
        content: summary,
        metadata: {
          planId: params.planId,
          success: params.success,
          stepsCompleted: progress.completed,
          stepsTotal: progress.total,
          iterations: params.totalIterations,
        },
      });

      logger.info(
        { planId: params.planId, success: params.success },
        "Plan summary stored in memory",
      );
    },

    /** Retrieve past episodes for similar goals (simple keyword search) */
    async recallRelevantExperience(companyId: string, goal: string, limit = 5) {
      return memories.searchMemories(companyId, goal, limit);
    },

    /** Store a short-term observation for the current execution session */
    async storeSessionObservation(
      companyId: string,
      agentId: string,
      key: string,
      value: string,
    ) {
      await memories.storeShortTerm({
        companyId,
        agentId,
        key: `episodic:${key}`,
        value,
        ttlSeconds: 3600, // 1 hour session memory
      });
    },
  };
}
