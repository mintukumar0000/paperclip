import type { GoalStatus } from "./goalAnalyzer.js";
import pino from "pino";

const logger = pino({ name: "task-generator" });

export interface GeneratedTask {
  title: string;
  description: string;
  priority: string;
  goalId: string;
  suggestedRole?: string;
}

/**
 * Generates new tasks based on goal analysis.
 * Uses rule-based heuristics. Can be upgraded to LLM-based generation.
 */
export function generateTasksForGoal(goal: GoalStatus): GeneratedTask[] {
  const tasks: GeneratedTask[] = [];

  // Rule: If a goal has no issues at all, create starter tasks
  if (goal.totalIssues === 0) {
    tasks.push({
      title: `Plan approach for: ${goal.title}`,
      description: `Analyze the goal "${goal.title}" and break it down into actionable tasks.`,
      priority: "high",
      goalId: goal.goalId,
      suggestedRole: "ceo",
    });
    tasks.push({
      title: `Execute first deliverable for: ${goal.title}`,
      description: `Start working on the first concrete deliverable for "${goal.title}".`,
      priority: "medium",
      goalId: goal.goalId,
      suggestedRole: "engineer",
    });
  }

  // Rule: If goal is stale (has issues but no progress), create unblocking task
  if (goal.totalIssues > 0 && goal.inProgressIssues === 0 && goal.completionPercent < 50) {
    tasks.push({
      title: `Unblock progress on: ${goal.title}`,
      description: `Review why "${goal.title}" is stalled at ${goal.completionPercent}% completion. Identify blockers and create action items.`,
      priority: "urgent",
      goalId: goal.goalId,
      suggestedRole: "manager",
    });
  }

  // Rule: If goal is near completion, create finalization task
  if (goal.completionPercent >= 80 && goal.completionPercent < 100 && goal.status !== "done") {
    tasks.push({
      title: `Finalize: ${goal.title}`,
      description: `Goal is at ${goal.completionPercent}% completion. Review remaining work and close it out.`,
      priority: "high",
      goalId: goal.goalId,
      suggestedRole: "manager",
    });
  }

  logger.info(
    { goalId: goal.goalId, generatedCount: tasks.length },
    "Tasks generated for goal",
  );
  return tasks;
}
