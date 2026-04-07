// ---------------------------------------------------------------------------
// Plan Store — CRUD operations for agent_plans table
// ---------------------------------------------------------------------------

import type { Db } from "@paperclipai/db";
import { agentPlans } from "@paperclipai/db";
import { eq, and, desc } from "@paperclipai/db";
import type { TaskGraph } from "../planning/taskGraph.js";
import pino from "pino";

const logger = pino({ name: "plan-store" });

export type PlanStatus = "planning" | "active" | "completed" | "failed" | "cancelled";

export interface CreatePlanInput {
  companyId: string;
  agentId: string;
  issueId?: string;
  goal: string;
  graph: TaskGraph;
  maxIterations?: number;
}

export function planStore(db: Db) {
  return {
    /** Create a new plan */
    async createPlan(input: CreatePlanInput) {
      const [plan] = await db
        .insert(agentPlans)
        .values({
          companyId: input.companyId,
          agentId: input.agentId,
          issueId: input.issueId ?? null,
          goal: input.goal,
          status: "planning",
          graphJson: input.graph as any,
          episodicJson: [],
          stepsTotal: input.graph.steps.length,
          maxIterations: input.maxIterations ?? 25,
        })
        .returning();

      logger.info({ planId: plan.id, goal: input.goal }, "Plan created");
      return plan;
    },

    /** Get a plan by ID */
    async getPlan(planId: string) {
      const [plan] = await db
        .select()
        .from(agentPlans)
        .where(eq(agentPlans.id, planId));
      return plan ?? null;
    },

    /** Get a plan by ID with company scope */
    async getPlanScoped(planId: string, companyId: string) {
      const [plan] = await db
        .select()
        .from(agentPlans)
        .where(and(eq(agentPlans.id, planId), eq(agentPlans.companyId, companyId)));
      return plan ?? null;
    },

    /** List plans for a company */
    async listPlans(companyId: string, opts?: { agentId?: string; status?: PlanStatus; limit?: number }) {
      const conditions = [eq(agentPlans.companyId, companyId)];
      if (opts?.agentId) conditions.push(eq(agentPlans.agentId, opts.agentId));
      if (opts?.status) conditions.push(eq(agentPlans.status, opts.status));

      return db
        .select()
        .from(agentPlans)
        .where(and(...conditions))
        .orderBy(desc(agentPlans.createdAt))
        .limit(opts?.limit ?? 50);
    },

    /** Update plan status */
    async updatePlanStatus(planId: string, status: PlanStatus, errorMessage?: string) {
      const values: Record<string, unknown> = {
        status,
        updatedAt: new Date(),
      };
      if (errorMessage !== undefined) values.errorMessage = errorMessage;
      if (status === "completed" || status === "failed" || status === "cancelled") {
        values.completedAt = new Date();
      }

      const [updated] = await db
        .update(agentPlans)
        .set(values)
        .where(eq(agentPlans.id, planId))
        .returning();

      logger.info({ planId, status }, "Plan status updated");
      return updated ?? null;
    },

    /** Update plan graph and progress */
    async updatePlanGraph(
      planId: string,
      graph: TaskGraph,
      progress: { stepsCompleted: number; iterationsUsed: number; currentStep?: string },
    ) {
      const [updated] = await db
        .update(agentPlans)
        .set({
          graphJson: graph as any,
          stepsCompleted: progress.stepsCompleted,
          stepsTotal: graph.steps.length,
          iterationsUsed: progress.iterationsUsed,
          currentStep: progress.currentStep ?? null,
          updatedAt: new Date(),
        })
        .where(eq(agentPlans.id, planId))
        .returning();

      return updated ?? null;
    },

    /** Append episodic memory entry to a plan */
    async appendEpisodic(planId: string, entry: Record<string, unknown>) {
      const plan = await this.getPlan(planId);
      if (!plan) return null;

      const existing = Array.isArray(plan.episodicJson) ? plan.episodicJson : [];
      const updated = [...existing, entry];

      const [result] = await db
        .update(agentPlans)
        .set({ episodicJson: updated, updatedAt: new Date() })
        .where(eq(agentPlans.id, planId))
        .returning();

      return result ?? null;
    },

    /** Cancel a running plan */
    async cancelPlan(planId: string, companyId: string) {
      const plan = await this.getPlanScoped(planId, companyId);
      if (!plan) return null;
      if (plan.status === "completed" || plan.status === "cancelled") return plan;

      return this.updatePlanStatus(planId, "cancelled");
    },

    /** Get active plans for an agent */
    async getActivePlans(agentId: string) {
      return db
        .select()
        .from(agentPlans)
        .where(and(eq(agentPlans.agentId, agentId), eq(agentPlans.status, "active")));
    },
  };
}
