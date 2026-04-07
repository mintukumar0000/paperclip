// ---------------------------------------------------------------------------
// Loop Scheduler — heartbeat-driven plan execution scheduler
// ---------------------------------------------------------------------------

import type { Db } from "@paperclipai/db";
import { agentPlans, agents, issues } from "@paperclipai/db";
import { eq, and } from "@paperclipai/db";
import { agentOrchestrator } from "./agentOrchestrator.js";
import { randomUUID } from "node:crypto";
import pino from "pino";

const logger = pino({ name: "loop-scheduler" });

/**
 * Check for active plans that need execution and resume them.
 * Called from heartbeat or a periodic scheduler.
 */
export async function tickScheduler(db: Db): Promise<{ resumed: number; errors: string[] }> {
  const orchestrator = agentOrchestrator(db);
  const errors: string[] = [];
  let resumed = 0;

  // Find active plans that aren't currently running
  const activePlans = await db
    .select()
    .from(agentPlans)
    .where(eq(agentPlans.status, "active"));

  for (const plan of activePlans) {
    // Skip if already running in-memory
    if (orchestrator.isGoalRunning(plan.id)) continue;

    // Fetch agent and issue to rebuild context
    const [agent] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, plan.agentId));

    if (!agent) {
      errors.push(`Plan ${plan.id}: agent ${plan.agentId} not found`);
      continue;
    }

    let issue = null;
    if (plan.issueId) {
      const rows = await db
        .select()
        .from(issues)
        .where(eq(issues.id, plan.issueId));
      issue = rows[0] ?? null;
    }

    // Resume the plan
    try {
      logger.info({ planId: plan.id, agentId: plan.agentId }, "Resuming plan from scheduler");

      // Fire and forget (async) — the orchestrator handles its own lifecycle
      orchestrator.executeGoal({
        companyId: plan.companyId,
        agentId: plan.agentId,
        issueId: plan.issueId ?? "",
        goal: plan.goal,
        context: {
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
        },
        maxIterations: plan.maxIterations - plan.iterationsUsed,
      }).catch((err) => {
        logger.error({ err, planId: plan.id }, "Resumed plan execution failed");
      });

      resumed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Resume failed";
      errors.push(`Plan ${plan.id}: ${msg}`);
      logger.error({ err, planId: plan.id }, "Failed to resume plan");
    }
  }

  logger.info({ resumed, errors: errors.length }, "Scheduler tick completed");
  return { resumed, errors };
}

/**
 * Start a periodic scheduler that ticks every N seconds.
 * Returns a cleanup function to stop the scheduler.
 */
export function startLoopScheduler(db: Db, intervalMs = 30_000): () => void {
  logger.info({ intervalMs }, "Starting loop scheduler");

  const timer = setInterval(() => {
    tickScheduler(db).catch((err) => {
      logger.error({ err }, "Scheduler tick error");
    });
  }, intervalMs);

  return () => {
    clearInterval(timer);
    logger.info("Loop scheduler stopped");
  };
}
