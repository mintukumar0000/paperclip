// ---------------------------------------------------------------------------
// Playbook Execution Engine
// ---------------------------------------------------------------------------
// Translates organizational playbook steps into executable tasks (issues).
// When a playbook is triggered, each step becomes an issue that can be
// assigned to agents and tracked through the normal issue lifecycle.
// ---------------------------------------------------------------------------

import type { Db } from "@paperclipai/db";
import { eq, sql } from "@paperclipai/db";
import { organizationalPlaybooks } from "@paperclipai/db";
import pino from "pino";
import { eventBus } from "../../events/eventBus.js";
import { issueService } from "../../services/index.js";

const logger = pino({ name: "playbook-engine" });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single step in a playbook */
export interface PlaybookStep {
  order: number;
  action: string;
  details?: string;
}

/** Options for executing a playbook */
export interface PlaybookExecutionOptions {
  companyId: string;
  playbookId: string;
  /** Who triggered the execution */
  triggeredBy: string;
  /** Optional project to group the created issues under */
  projectId?: string;
  /** Optional goal to link the created issues to */
  goalId?: string;
  /** Optional agent to assign all tasks to */
  assigneeAgentId?: string;
}

/** Result of a single step's task creation */
export interface StepExecutionResult {
  stepOrder: number;
  stepAction: string;
  issueId: string;
  issueTitle: string;
  status: "created" | "failed";
  error?: string;
}

/** Result of executing an entire playbook */
export interface PlaybookExecutionResult {
  playbookId: string;
  playbookTitle: string;
  totalSteps: number;
  stepsCreated: number;
  stepsFailed: number;
  results: StepExecutionResult[];
  executionTime: number;
}

// ---------------------------------------------------------------------------
// Core Engine
// ---------------------------------------------------------------------------

/**
 * Execute a playbook by converting its steps into issues/tasks.
 * Each step becomes a separate issue with:
 *   - Title derived from the step action
 *   - Description from step details
 *   - Priority set by step order (earlier = higher)
 *   - All linked to the same project/goal if specified
 */
export async function executePlaybook(
  db: Db,
  options: PlaybookExecutionOptions,
): Promise<PlaybookExecutionResult> {
  const start = Date.now();

  // Fetch the playbook
  const rows = await db
    .select()
    .from(organizationalPlaybooks)
    .where(eq(organizationalPlaybooks.id, options.playbookId));
  const playbook = rows[0] ?? null;

  if (!playbook) {
    throw new Error(`Playbook not found: ${options.playbookId}`);
  }

  if (playbook.companyId !== options.companyId) {
    throw new Error("Playbook does not belong to this company");
  }

  if (!playbook.active) {
    throw new Error("Playbook is not active");
  }

  const steps = (playbook.steps ?? []) as PlaybookStep[];
  if (steps.length === 0) {
    throw new Error("Playbook has no steps to execute");
  }

  // Sort steps by order
  const sortedSteps = [...steps].sort((a, b) => a.order - b.order);

  const svc = issueService(db);
  const results: StepExecutionResult[] = [];
  let stepsCreated = 0;
  let stepsFailed = 0;

  // Map step position to priority: first steps are higher priority
  function stepPriority(index: number, total: number): "urgent" | "high" | "medium" | "low" {
    const ratio = index / total;
    if (ratio < 0.25) return "high";
    if (ratio < 0.5) return "medium";
    return "low";
  }

  for (let i = 0; i < sortedSteps.length; i++) {
    const step = sortedSteps[i];
    const stepTitle = `[Playbook] ${playbook.title} — Step ${step.order}: ${step.action}`;
    const stepDescription = step.details
      ? `Playbook: ${playbook.title}\nStep ${step.order} of ${sortedSteps.length}\n\n${step.details}`
      : `Playbook: ${playbook.title}\nStep ${step.order} of ${sortedSteps.length}\n\nAction: ${step.action}`;

    try {
      const issue = await svc.create(options.companyId, {
        title: stepTitle,
        description: stepDescription,
        status: "backlog",
        priority: stepPriority(i, sortedSteps.length),
        projectId: options.projectId ?? null,
        goalId: options.goalId ?? null,
        assigneeAgentId: options.assigneeAgentId ?? null,
      });

      results.push({
        stepOrder: step.order,
        stepAction: step.action,
        issueId: issue.id,
        issueTitle: stepTitle,
        status: "created",
      });
      stepsCreated++;

      eventBus.publish("governance.playbook.step_completed", {
        companyId: options.companyId,
        playbookId: options.playbookId,
        stepOrder: step.order,
        issueId: issue.id,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      results.push({
        stepOrder: step.order,
        stepAction: step.action,
        issueId: "",
        issueTitle: stepTitle,
        status: "failed",
        error: errorMsg,
      });
      stepsFailed++;

      logger.error(
        { companyId: options.companyId, playbookId: options.playbookId, step: step.order, error: errorMsg },
        "Failed to create issue for playbook step",
      );
    }
  }

  // Increment timesApplied on the playbook
  await db
    .update(organizationalPlaybooks)
    .set({ timesApplied: sql`${organizationalPlaybooks.timesApplied} + 1`, updatedAt: new Date() })
    .where(eq(organizationalPlaybooks.id, options.playbookId));

  const executionTime = Date.now() - start;

  // Emit aggregate telemetry
  eventBus.publish("governance.playbook.executed", {
    companyId: options.companyId,
    playbookId: options.playbookId,
    playbookTitle: playbook.title,
    totalSteps: sortedSteps.length,
    stepsCreated,
    stepsFailed,
    triggeredBy: options.triggeredBy,
    executionTimeMs: executionTime,
    timestamp: new Date().toISOString(),
  });

  logger.info(
    {
      companyId: options.companyId,
      playbookId: options.playbookId,
      stepsCreated,
      stepsFailed,
      executionTimeMs: executionTime,
    },
    "Playbook execution completed",
  );

  return {
    playbookId: options.playbookId,
    playbookTitle: playbook.title,
    totalSteps: sortedSteps.length,
    stepsCreated,
    stepsFailed,
    results,
    executionTime,
  };
}
