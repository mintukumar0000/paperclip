import type { Db } from "@paperclipai/db";
import { companies, agents, issues } from "@paperclipai/db";
import { eq, and, isNull, inArray, or } from "@paperclipai/db";
import pino from "pino";
import { publishEvent } from "../events/eventPublisher.js";
import { strategyEngine } from "../strategy/strategyEngine.js";
import { dispatchAgentExecution } from "../services/agentDispatchService.js";
import { recordSystemMetric, getRecentSystemMetricsSnapshot } from "../ai/feedback/metricsEngine.js";
import { runAutonomousDecisionCycle } from "../ai/governance/decisionEngine.js";
import { getActiveCompanyId } from "./companyScope.js";
import { setCycleState } from "../services/cycle-state.js";
import { logActivity } from "../services/activity-log.js";
import { getSystemControls } from "../services/system-controls.js";

const logger = pino({ name: "execution-loop" });

const DEFAULT_MAX_EXECUTIONS_PER_CYCLE = 2;
const DEFAULT_MAX_ACTIVE_AGENTS = 3;
const DEFAULT_MAX_EXECUTIONS_PER_HOUR = 10;
const EXECUTION_BUDGET_WINDOW_MS = 60 * 60_000;

const executionBudgetState = new Map<string, {
  windowStartedAt: number;
  executionsInWindow: number;
}>();

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function getCompanyExecutionBudgetState(companyId: string): { windowStartedAt: number; executionsInWindow: number } {
  const now = Date.now();
  const current = executionBudgetState.get(companyId);
  if (!current || now - current.windowStartedAt >= EXECUTION_BUDGET_WINDOW_MS) {
    const fresh = { windowStartedAt: now, executionsInWindow: 0 };
    executionBudgetState.set(companyId, fresh);
    return fresh;
  }
  return current;
}

export interface LoopCycleResult {
  companyId: string;
  cycleStarted: string;
  cycleCompleted: string;
  goalsAnalyzed: number;
  tasksDispatched: number;
  agentsActivated: number;
}

/**
 * The execution loop orchestrates autonomous company operation.
 * Each cycle: analyze goals → identify work → assign agents → dispatch.
 */
export function executionLoop(db: Db) {
  const strategy = strategyEngine(db);

  return {
    /** Run one cycle of the execution loop for a company */
    async runCycle(companyId: string): Promise<LoopCycleResult> {
      const cycleStarted = new Date().toISOString();
      const cycleStartedAtMs = Date.now();
      const traceId = `execution_loop:${companyId}:${cycleStartedAtMs}`;
      const companyRow = await db
        .select({ id: companies.id, status: companies.status })
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);

      if (!companyRow || companyRow.status !== "active") {
        logger.info({ companyId, status: companyRow?.status ?? "missing" }, "Skipping execution cycle for inactive company");
        return {
          companyId,
          cycleStarted,
          cycleCompleted: new Date().toISOString(),
          goalsAnalyzed: 0,
          tasksDispatched: 0,
          agentsActivated: 0,
        };
      }

      const controls = await getSystemControls(db, companyId).catch(() => null);
      await setCycleState(db, companyId, "execution_loop", {
        status: "running",
        stage: "planning",
        currentAction: "analyze_goals",
        lastError: null,
        lastRunStartedAt: new Date(cycleStartedAtMs),
        details: {
          source: "execution_loop",
        },
      }).catch(() => undefined);

      const maxExecutionsPerCycle = readPositiveIntEnv(
        "MAX_EXECUTIONS_PER_CYCLE",
        DEFAULT_MAX_EXECUTIONS_PER_CYCLE,
      );
      const maxExecutionsPerHour = readPositiveIntEnv(
        "MAX_EXECUTIONS_PER_HOUR",
        DEFAULT_MAX_EXECUTIONS_PER_HOUR,
      );
      const maxActiveAgents = readPositiveIntEnv("MAX_ACTIVE_AGENTS", DEFAULT_MAX_ACTIVE_AGENTS);
      const hourlyBudget = getCompanyExecutionBudgetState(companyId);

      await logActivity(db, {
        companyId,
        actorType: "system",
        actorId: "execution-loop",
        action: "execution.execution.plan",
        entityType: "company",
        entityId: companyId,
        details: {
          status: "pending",
          source: "execution_loop",
          maxExecutionsPerCycle,
          maxExecutionsPerHour,
          maxActiveAgents,
          decisionMode: controls?.decisionMode ?? null,
          autonomyLevel: controls?.autonomyLevel ?? null,
          traceId,
        },
      }).catch(() => undefined);

      if (hourlyBudget.executionsInWindow >= maxExecutionsPerHour) {
        logger.warn(
          { companyId, maxExecutionsPerHour, executionsInWindow: hourlyBudget.executionsInWindow },
          "Execution loop hourly cap reached; skipping cycle dispatch",
        );
        await publishEvent("loop.cycle.completed", {
          companyId,
          cycleStarted,
          cycleCompleted: new Date().toISOString(),
          goalsAnalyzed: 0,
          tasksDispatched: 0,
          agentsActivated: 0,
          skippedBy: "hourly_execution_cap",
          maxExecutionsPerHour,
        });
        await logActivity(db, {
          companyId,
          actorType: "system",
          actorId: "execution-loop",
          action: "execution.execution.result",
          entityType: "company",
          entityId: companyId,
          details: {
            status: "blocked",
            source: "execution_loop",
            skippedBy: "hourly_execution_cap",
            maxExecutionsPerHour,
            traceId,
          },
        }).catch(() => undefined);
        await setCycleState(db, companyId, "execution_loop", {
          status: "blocked",
          stage: "idle",
          currentAction: null,
          lastRunCompletedAt: new Date(),
          lastRunDurationMs: Date.now() - cycleStartedAtMs,
          details: {
            reason: "hourly_execution_cap",
            maxExecutionsPerHour,
          },
        }).catch(() => undefined);
        return {
          companyId,
          cycleStarted,
          cycleCompleted: new Date().toISOString(),
          goalsAnalyzed: 0,
          tasksDispatched: 0,
          agentsActivated: 0,
        };
      }

      logger.info({ companyId }, "Execution loop cycle starting");

      await publishEvent("loop.cycle.started", { companyId, timestamp: cycleStarted });

      // 1. Run strategic analysis
      const plan = await strategy.runForCompany(companyId);

      // 2. Find unassigned issues that could be dispatched
      const unassignedIssues = await db
        .select()
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            inArray(issues.status, ["backlog", "todo"]),
            isNull(issues.assigneeAgentId),
          ),
        );

      // 3. Find available (idle) agents
      const availableAgents = await db
        .select()
        .from(agents)
        .where(
          and(
            eq(agents.companyId, companyId),
            eq(agents.status, "idle"),
          ),
        );
      const limitedAgents = availableAgents.slice(0, maxActiveAgents);

      // 4. Auto-assign: match agents to issues by role
      let tasksDispatched = 0;
      const activatedAgentIds = new Set<string>();
      const dispatchedIssueIds: string[] = [];

      for (const issue of unassignedIssues) {
        if (tasksDispatched >= maxExecutionsPerCycle) {
          logger.info(
            { companyId, maxExecutionsPerCycle },
            "Execution cap reached for cycle; deferring remaining issues",
          );
          break;
        }

        if (hourlyBudget.executionsInWindow >= maxExecutionsPerHour) {
          logger.info(
            { companyId, maxExecutionsPerHour, executionsInWindow: hourlyBudget.executionsInWindow },
            "Execution cap reached for hour; deferring remaining issues",
          );
          break;
        }

        if (!issue.assigneeAgentId && limitedAgents.length > 0) {
          // Find first available agent (simple round-robin; can be made smarter)
          const agent = limitedAgents.find(
            (a) => !activatedAgentIds.has(a.id),
          );
          if (!agent) break;

          try {
            const now = new Date();
            const claimedIssue = await db
              .update(issues)
              .set({
                assigneeAgentId: agent.id,
                assigneeUserId: null,
                status: "in_progress",
                startedAt: now,
                updatedAt: now,
              })
              .where(
                and(
                  eq(issues.id, issue.id),
                  inArray(issues.status, ["backlog", "todo"]),
                  or(isNull(issues.assigneeAgentId), eq(issues.assigneeAgentId, agent.id)),
                ),
              )
              .returning()
              .then((rows) => rows[0] ?? null);

            if (!claimedIssue) {
              logger.warn({ issueId: issue.id, agentId: agent.id }, "Issue could not be claimed for dispatch");
              continue;
            }

            try {
              await dispatchAgentExecution({
                agentId: agent.id,
                issueId: issue.id,
                companyId,
                context: { source: "execution-loop" },
                wakeReason: "execution-loop-cycle",
              });
              activatedAgentIds.add(agent.id);
              tasksDispatched++;
              dispatchedIssueIds.push(issue.id);
              hourlyBudget.executionsInWindow += 1;
            } catch (dispatchErr) {
              // Roll back the claim so the issue can be retried in a later cycle.
              await db
                .update(issues)
                .set({
                  assigneeAgentId: null,
                  assigneeUserId: null,
                  status: "todo",
                  startedAt: null,
                  updatedAt: new Date(),
                })
                .where(
                  and(
                    eq(issues.id, issue.id),
                    eq(issues.assigneeAgentId, agent.id),
                    eq(issues.status, "in_progress"),
                  ),
                );

              logger.error(
                { agentId: agent.id, issueId: issue.id, err: dispatchErr },
                "Failed to dispatch agent; issue claim rolled back",
              );
              continue;
            }
          } catch (err) {
            logger.error(
              { agentId: agent.id, issueId: issue.id, err },
              "Failed to dispatch agent",
            );
          }
        }
      }

      const cycleCompleted = new Date().toISOString();
      const result: LoopCycleResult = {
        companyId,
        cycleStarted,
        cycleCompleted,
        goalsAnalyzed: plan.goalSnapshots.length,
        tasksDispatched,
        agentsActivated: activatedAgentIds.size,
      };

      await publishEvent("loop.cycle.completed", { ...result });

      await logActivity(db, {
        companyId,
        actorType: "system",
        actorId: "execution-loop",
        action: "execution.execution.result",
        entityType: "company",
        entityId: companyId,
        details: {
          status: "success",
          source: "execution_loop",
          goalsAnalyzed: plan.goalSnapshots.length,
          linkedGoalIds: plan.goalSnapshots.map((goal) => goal.goalId),
          linkedIssueIds: dispatchedIssueIds,
          linkedAgentIds: Array.from(activatedAgentIds),
          tasksDispatched,
          agentsActivated: activatedAgentIds.size,
          traceId,
        },
      }).catch(() => undefined);

      await setCycleState(db, companyId, "execution_loop", {
        status: "completed",
        stage: "idle",
        currentAction: null,
        lastRunCompletedAt: new Date(),
        lastRunDurationMs: Date.now() - cycleStartedAtMs,
        details: {
          goalsAnalyzed: plan.goalSnapshots.length,
          linkedGoalIds: plan.goalSnapshots.map((goal) => goal.goalId),
          linkedIssueIds: dispatchedIssueIds,
          linkedAgentIds: Array.from(activatedAgentIds),
          tasksDispatched,
          agentsActivated: activatedAgentIds.size,
          traceId,
        },
      }).catch(() => undefined);

      try {
        const taskSuccessRate = tasksDispatched > 0
          ? Math.min(1, activatedAgentIds.size / tasksDispatched)
          : 0;

        await recordSystemMetric(db, {
          companyId,
          sourceType: "task_execution",
          sourceId: `cycle:${cycleCompleted}`,
          traffic: Math.max(tasksDispatched, 1),
          conversions: activatedAgentIds.size,
          revenueCents: 0,
          taskSuccessRate,
          costPerActionCents: 0,
          metadata: {
            goalsAnalyzed: plan.goalSnapshots.length,
            linkedGoalIds: plan.goalSnapshots.map((goal) => goal.goalId),
            linkedIssueIds: dispatchedIssueIds,
            linkedAgentIds: Array.from(activatedAgentIds),
            tasksDispatched,
            agentsActivated: activatedAgentIds.size,
            traceId,
          },
        });

        const snapshot = await getRecentSystemMetricsSnapshot(db, companyId, 180);
        await runAutonomousDecisionCycle(db, {
          companyId,
          metrics: snapshot,
          source: "execution_loop",
        });
      } catch (decisionErr) {
        logger.warn({ err: decisionErr, companyId }, "Decision loop hook failed after execution cycle");
      }

      logger.info(result, "Execution loop cycle completed");

      return result;
    },

    /** Run execution loop for all companies */
    async runAll(): Promise<LoopCycleResult[]> {
      const activeCompanyId = getActiveCompanyId();
      const companyIds = await db
        .select({ id: companies.id })
        .from(companies)
        .where(eq(companies.status, "active"))
        .then((rows) => rows.map((row) => row.id));

      if (activeCompanyId) {
        logger.warn(
          { activeCompanyId, totalActiveCompanies: companyIds.length },
          "ACTIVE_COMPANY_ID is configured but execution loop now runs all active companies",
        );
      }

      const results: LoopCycleResult[] = [];

      for (const companyId of companyIds) {
        try {
          const result = await this.runCycle(companyId);
          results.push(result);
        } catch (err) {
          logger.error({ companyId, err }, "Execution loop failed for company");
        }
      }

      return results;
    },
  };
}
