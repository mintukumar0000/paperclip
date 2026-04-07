import type { Db } from "@paperclipai/db";
import { goals, issues } from "@paperclipai/db";
import { eq, and } from "@paperclipai/db";
import pino from "pino";

const logger = pino({ name: "goal-analyzer" });

export interface GoalStatus {
  goalId: string;
  title: string;
  level: string;
  status: string;
  totalIssues: number;
  completedIssues: number;
  inProgressIssues: number;
  completionPercent: number;
}

/**
 * Analyzes the state of company goals vs actual work completion.
 */
export function goalAnalyzer(db: Db) {
  return {
    async analyzeGoals(companyId: string): Promise<GoalStatus[]> {
      const allGoals = await db
        .select()
        .from(goals)
        .where(eq(goals.companyId, companyId));

      const allIssues = await db
        .select()
        .from(issues)
        .where(eq(issues.companyId, companyId));

      const results: GoalStatus[] = allGoals.map((goal) => {
        const goalIssues = allIssues.filter((i) => i.goalId === goal.id);
        const completed = goalIssues.filter((i) => i.status === "done").length;
        const inProgress = goalIssues.filter((i) => i.status === "in_progress").length;
        const total = goalIssues.length;

        return {
          goalId: goal.id,
          title: goal.title,
          level: goal.level,
          status: goal.status,
          totalIssues: total,
          completedIssues: completed,
          inProgressIssues: inProgress,
          completionPercent: total > 0 ? Math.round((completed / total) * 100) : 0,
        };
      });

      logger.info(
        { companyId, goalCount: results.length },
        "Goals analyzed",
      );
      return results;
    },

    /** Find goals that need attention (low completion, no active work) */
    async findStaleGoals(companyId: string): Promise<GoalStatus[]> {
      const all = await this.analyzeGoals(companyId);
      return all.filter(
        (g) =>
          g.status !== "done" &&
          g.completionPercent < 80 &&
          g.inProgressIssues === 0,
      );
    },
  };
}
