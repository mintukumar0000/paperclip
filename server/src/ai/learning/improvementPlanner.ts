// ---------------------------------------------------------------------------
// Improvement Planner — converts reflections into actionable improvement tasks
// ---------------------------------------------------------------------------

import type { Db } from "@paperclipai/db";
import { aiLearningRecords } from "@paperclipai/db";
import { eq, and, desc } from "@paperclipai/db";
import type { Reflection } from "./reflectionEngine.js";
import { publishEvent } from "../../events/eventPublisher.js";
import { capPlanningTasks } from "../governance/goalContainment.js";
import pino from "pino";

const logger = pino({ name: "improvement-planner" });

export type ImprovementAction =
  | "update_prompt"
  | "add_workflow_step"
  | "remove_workflow_step"
  | "reroute_tasks"
  | "adjust_budget"
  | "retrain_agent"
  | "update_strategy"
  | "add_validation_step";

export interface ImprovementPlan {
  id: string;
  companyId: string;
  action: ImprovementAction;
  target: string;             // e.g. agent ID, prompt name, workflow name
  reason: string;
  expectedImpact: "low" | "medium" | "high";
  requiresApproval: boolean;  // true for high-impact changes
  sourceReflectionId?: string;
  details: Record<string, unknown>;
  status: "proposed" | "approved" | "applied" | "rolled_back";
  createdAt: Date;
}

export interface PlanningResult {
  companyId: string;
  plans: ImprovementPlan[];
  autoApplicable: ImprovementPlan[];
  needsApproval: ImprovementPlan[];
  generatedAt: Date;
}

/** Improvement actions that are safe to auto-apply (low risk) */
const SAFE_AUTO_APPLY: Set<ImprovementAction> = new Set([
  "update_prompt",
  "add_validation_step",
]);

/** Improvement actions that always require human approval */
const REQUIRES_APPROVAL: Set<ImprovementAction> = new Set([
  "remove_workflow_step",
  "retrain_agent",
  "adjust_budget",
  "update_strategy",
]);

/**
 * Generate improvement plans from reflections.
 */
export async function planImprovements(
  db: Db,
  companyId: string,
  reflections: Reflection[],
): Promise<PlanningResult> {
  const plans: ImprovementPlan[] = [];

  for (const reflection of reflections) {
    const plan = reflectionToPlan(companyId, reflection);
    if (plan) plans.push(plan);
  }

  // Deduplicate plans targeting the same resource
  const deduped = deduplicatePlans(plans);

  // Cap improvement plans per cycle to prevent runaway improvement cascades
  const capped = capPlanningTasks(deduped, companyId);

  // Categorize
  const autoApplicable = capped.filter((p) => !p.requiresApproval);
  const needsApproval = capped.filter((p) => p.requiresApproval);

  // Persist plans as learning records
  for (const plan of capped) {
    await db.insert(aiLearningRecords).values({
      companyId,
      recordType: "improvement",
      category: plan.action.startsWith("update_prompt") ? "prompt"
        : plan.action.includes("workflow") ? "workflow"
        : plan.action.includes("strategy") ? "strategy"
        : "general",
      summary: `${plan.action}: ${plan.reason}`,
      details: {
        planId: plan.id,
        action: plan.action,
        target: plan.target,
        expectedImpact: plan.expectedImpact,
        requiresApproval: plan.requiresApproval,
        status: plan.status,
      },
      recommendedChange: plan.reason,
    });
  }

  await publishEvent("ai.learning.improvements.planned", {
    companyId,
    totalPlans: capped.length,
    autoApplicable: autoApplicable.length,
    needsApproval: needsApproval.length,
  });

  logger.info(
    { companyId, plans: capped.length, auto: autoApplicable.length, approval: needsApproval.length },
    "Improvement plans generated",
  );

  return {
    companyId,
    plans: capped,
    autoApplicable,
    needsApproval,
    generatedAt: new Date(),
  };
}

/**
 * Load unapplied improvement plans for a company.
 */
export async function getUnappliedPlans(
  db: Db,
  companyId: string,
): Promise<ImprovementPlan[]> {
  const records = await db
    .select()
    .from(aiLearningRecords)
    .where(
      and(
        eq(aiLearningRecords.companyId, companyId),
        eq(aiLearningRecords.recordType, "improvement"),
        eq(aiLearningRecords.applied, false),
      ),
    )
    .orderBy(desc(aiLearningRecords.createdAt))
    .limit(50);

  return records.map((r) => {
    const d = r.details as Record<string, unknown>;
    return {
      id: d.planId as string ?? r.id,
      companyId: r.companyId,
      action: d.action as ImprovementAction,
      target: d.target as string ?? "",
      reason: r.summary,
      expectedImpact: d.expectedImpact as "low" | "medium" | "high" ?? "medium",
      requiresApproval: d.requiresApproval as boolean ?? false,
      details: d,
      status: d.status as ImprovementPlan["status"] ?? "proposed",
      createdAt: r.createdAt,
    };
  });
}

/**
 * Mark an improvement plan as applied.
 */
export async function markPlanApplied(
  db: Db,
  planId: string,
  companyId: string,
): Promise<boolean> {
  const records = await db
    .select()
    .from(aiLearningRecords)
    .where(
      and(
        eq(aiLearningRecords.companyId, companyId),
        eq(aiLearningRecords.recordType, "improvement"),
      ),
    )
    .limit(100);

  for (const record of records) {
    const d = record.details as Record<string, unknown>;
    if (d.planId === planId) {
      await db
        .update(aiLearningRecords)
        .set({ applied: true, appliedAt: new Date() })
        .where(eq(aiLearningRecords.id, record.id));

      await publishEvent("ai.learning.improvement.applied", {
        companyId,
        planId,
        action: d.action,
        target: d.target,
      });

      return true;
    }
  }
  return false;
}

/**
 * Roll back a previously applied improvement.
 */
export async function rollbackPlan(
  db: Db,
  planId: string,
  companyId: string,
): Promise<boolean> {
  const records = await db
    .select()
    .from(aiLearningRecords)
    .where(
      and(
        eq(aiLearningRecords.companyId, companyId),
        eq(aiLearningRecords.recordType, "improvement"),
        eq(aiLearningRecords.applied, true),
      ),
    )
    .limit(100);

  for (const record of records) {
    const d = record.details as Record<string, unknown>;
    if (d.planId === planId) {
      await db
        .update(aiLearningRecords)
        .set({ rolledBack: true, rolledBackAt: new Date() })
        .where(eq(aiLearningRecords.id, record.id));

      await publishEvent("ai.learning.improvement.rolledback", {
        companyId,
        planId,
        action: d.action,
        target: d.target,
      });

      logger.info({ companyId, planId }, "Improvement rolled back");
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function reflectionToPlan(
  companyId: string,
  reflection: Reflection,
): ImprovementPlan | null {
  const actionMap: Record<Reflection["category"], ImprovementAction> = {
    prompt: "update_prompt",
    workflow: "add_workflow_step",
    strategy: "update_strategy",
    routing: "reroute_tasks",
    budget: "adjust_budget",
    general: "add_validation_step",
  };

  const action = actionMap[reflection.category];
  const requiresApproval = REQUIRES_APPROVAL.has(action) ||
    reflection.priority === "critical" ||
    (reflection.priority === "high" && !SAFE_AUTO_APPLY.has(action));

  return {
    id: crypto.randomUUID(),
    companyId,
    action,
    target: reflection.evidence.agentId as string ?? reflection.goalId ?? "company",
    reason: reflection.recommendation,
    expectedImpact: reflection.priority === "critical" || reflection.priority === "high" ? "high"
      : reflection.priority === "medium" ? "medium" : "low",
    requiresApproval,
    sourceReflectionId: reflection.id,
    details: {
      observation: reflection.observation,
      hypothesis: reflection.hypothesis,
      confidence: reflection.confidence,
    },
    status: "proposed",
    createdAt: new Date(),
  };
}

function deduplicatePlans(plans: ImprovementPlan[]): ImprovementPlan[] {
  const seen = new Set<string>();
  return plans.filter((p) => {
    const key = `${p.action}:${p.target}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
