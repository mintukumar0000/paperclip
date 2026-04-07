import type { Db } from "@paperclipai/db";
import pino from "pino";
import { planningEngine } from "./planningEngine.js";
import { publishEvent } from "../events/eventPublisher.js";
import { listScopedCompanyIds } from "../core/companyScope.js";

const logger = pino({ name: "strategy-engine" });

/**
 * Top-level strategy engine that orchestrates planning across companies.
 * Can be triggered on a schedule or on-demand.
 */
export function strategyEngine(db: Db) {
  const planner = planningEngine(db);

  return {
    /** Run strategic planning for a single company */
    async runForCompany(companyId: string) {
      logger.info({ companyId }, "Running strategy engine for company");
      const plan = await planner.buildPlan(companyId);

      await publishEvent("strategy.planned", {
        companyId,
        goalsAnalyzed: plan.goalSnapshots.length,
        tasksGenerated: plan.generatedTasks.length,
        staleGoals: plan.staleGoalIds.length,
      });

      return plan;
    },

    /** Run strategic planning for all companies */
    async runForAll() {
      const companyIds = await listScopedCompanyIds(db);
      const results = [];

      for (const companyId of companyIds) {
        try {
          const plan = await planner.buildPlan(companyId);
          results.push({ companyId, status: "ok" as const, plan });
        } catch (err) {
          logger.error({ companyId, err }, "Strategy engine failed for company");
          results.push({ companyId, status: "error" as const, error: String(err) });
        }
      }

      logger.info(
        { companiesProcessed: results.length },
        "Strategy engine run complete",
      );
      return results;
    },

    /** List plans for a company */
    async listPlans(companyId: string) {
      return planner.listPlans(companyId);
    },
  };
}
