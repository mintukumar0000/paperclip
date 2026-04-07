import type { Db } from "@paperclipai/db";
import { strategyPlans } from "@paperclipai/db";
import { eq } from "@paperclipai/db";
import pino from "pino";
import { goalAnalyzer, type GoalStatus } from "./goalAnalyzer.js";
import { generateTasksForGoal, type GeneratedTask } from "./taskGenerator.js";
import { capPlanningTasks } from "../ai/governance/goalContainment.js";

const logger = pino({ name: "planning-engine" });

export interface StrategicPlan {
  companyId: string;
  goalSnapshots: GoalStatus[];
  generatedTasks: GeneratedTask[];
  staleGoalIds: string[];
}

/**
 * Runs strategic analysis for a company: evaluates goal state,
 * identifies bottlenecks, and generates task recommendations.
 */
export function planningEngine(db: Db) {
  const analyzer = goalAnalyzer(db);

  return {
    async buildPlan(companyId: string): Promise<StrategicPlan> {
      const goalSnapshots = await analyzer.analyzeGoals(companyId);
      const staleGoals = await analyzer.findStaleGoals(companyId);
      const staleGoalIds = staleGoals.map((g) => g.goalId);

      // Generate tasks for each goal that needs attention
      const generatedTasks: GeneratedTask[] = [];
      for (const goal of goalSnapshots) {
        const tasks = generateTasksForGoal(goal);
        generatedTasks.push(...tasks);
      }

      // Cap tasks per planning cycle to prevent runaway task generation
      const cappedTasks = capPlanningTasks(generatedTasks, companyId);

      const plan: StrategicPlan = {
        companyId,
        goalSnapshots,
        generatedTasks: cappedTasks,
        staleGoalIds,
      };

      // Persist the plan
      await db.insert(strategyPlans).values({
        companyId,
        analysis: goalSnapshots,
        generatedTasks: cappedTasks,
        status: "pending",
      });

      logger.info(
        {
          companyId,
          goalsAnalyzed: goalSnapshots.length,
          tasksGenerated: cappedTasks.length,
          tasksCapped: generatedTasks.length > cappedTasks.length,
          staleGoals: staleGoalIds.length,
        },
        "Strategic plan built",
      );

      return plan;
    },

    async listPlans(companyId: string) {
      return db
        .select()
        .from(strategyPlans)
        .where(eq(strategyPlans.companyId, companyId))
        .orderBy(strategyPlans.createdAt);
    },
  };
}
