// ---------------------------------------------------------------------------
// AI Dashboard Routes — Phase 20: Human-in-the-Loop Dashboard & Monitoring
// ---------------------------------------------------------------------------
//
// Provides:
//   GET  /companies/:companyId/ai/dashboard         — aggregated AI execution state
//   GET  /companies/:companyId/ai/dashboard/events   — SSE event stream
//   POST /companies/:companyId/ai/goals/:goalId/retry     — retry a failed goal step
//   POST /companies/:companyId/ai/goals/:goalId/reassign  — reassign goal to another agent
// ---------------------------------------------------------------------------

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { agentPlans, agents, issues } from "@paperclipai/db";
import { eq, and, desc, sql } from "@paperclipai/db";
import { assertCompanyAccess } from "./authz.js";
import { planStore } from "../ai/memory/planStore.js";
import { episodicMemory } from "../ai/memory/episodicMemory.js";
import { agentOrchestrator } from "../ai/orchestration/agentOrchestrator.js";
import { detectCapabilities } from "../ai/runtime/capabilities.js";
import { getEngineRegistry } from "../ai/runtime/engineRegistry.js";
import { listEnginesByCategory } from "../ai/router/adapterRouter.js";
import { eventBus } from "../events/eventBus.js";
import { logActivity } from "../services/activity-log.js";
import type { EventName, EventPayload, PaperclipEvent } from "../events/eventTypes.js";
import {
  type TaskGraph,
  getReadySteps,
  getGraphProgress,
  resetStepForRetry,
} from "../ai/planning/taskGraph.js";
import pino from "pino";

const logger = pino({ name: "ai-dashboard-routes" });

// AI event names that the dashboard SSE stream relays
const AI_EVENTS: EventName[] = [
  "ai.execution.started",
  "ai.execution.completed",
  "ai.goal.created",
  "ai.goal.completed",
  "ai.goal.failed",
  "ai.goal.cancelled",
  "ai.step.started",
  "ai.step.completed",
  "ai.step.failed",
  "company.loop.tick",
  "company.loop.completed",
  "engine.resolved",
  "engine.unavailable",
];

export function aiDashboardRoutes(db: Db) {
  const router = Router();

  // -----------------------------------------------------------------------
  // GET /companies/:companyId/ai/dashboard
  // Aggregated overview of the AI execution pipeline.
  // -----------------------------------------------------------------------
  router.get("/companies/:companyId/ai/dashboard", async (req, res) => {
    try {
      const { companyId } = req.params;
      assertCompanyAccess(req, companyId);

      const store = planStore(db);
      const orchestrator = agentOrchestrator(db);

      // Parallel queries
      const [activePlans, allPlans, agentRows] = await Promise.all([
        store.listPlans(companyId, { status: "active", limit: 100 }),
        store.listPlans(companyId, { limit: 200 }),
        db
          .select()
          .from(agents)
          .where(eq(agents.companyId, companyId)),
      ]);

      // Goal statistics
      const goalStats = {
        active: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
        planning: 0,
        total: allPlans.length,
      };
      for (const plan of allPlans) {
        const status = plan.status as string;
        if (status in goalStats) {
          (goalStats as Record<string, number>)[status]++;
        }
      }

      // Active goals with step progress
      const activeGoals = activePlans.map((plan) => {
        const graph = plan.graphJson as unknown as TaskGraph;
        const progress = graph?.steps ? getGraphProgress(graph) : { total: 0, completed: 0, failed: 0, running: 0, pending: 0 };
        const readySteps = graph?.steps ? getReadySteps(graph) : [];
        return {
          id: plan.id,
          goal: plan.goal,
          agentId: plan.agentId,
          issueId: plan.issueId,
          status: plan.status,
          isRunning: orchestrator.isGoalRunning(plan.id),
          progress,
          nextStep: readySteps[0]?.name ?? null,
          iterationsUsed: plan.iterationsUsed,
          maxIterations: plan.maxIterations,
          createdAt: plan.createdAt,
          updatedAt: plan.updatedAt,
        };
      });

      // Recent completed/failed goals
      const recentGoals = allPlans
        .filter((p) => p.status === "completed" || p.status === "failed")
        .slice(0, 20)
        .map((plan) => ({
          id: plan.id,
          goal: plan.goal,
          agentId: plan.agentId,
          issueId: plan.issueId,
          status: plan.status,
          iterationsUsed: plan.iterationsUsed,
          errorMessage: plan.errorMessage,
          createdAt: plan.createdAt,
          completedAt: plan.completedAt,
        }));

      // Agent execution states
      const agentStates = agentRows.map((agent) => {
        const agentPlansData = allPlans.filter((p) => p.agentId === agent.id);
        const activePlan = agentPlansData.find((p) => p.status === "active");
        return {
          id: agent.id,
          name: agent.name,
          status: agent.status,
          currentGoal: activePlan
            ? { planId: activePlan.id, goal: activePlan.goal }
            : null,
          totalGoals: agentPlansData.length,
          completedGoals: agentPlansData.filter((p) => p.status === "completed").length,
          failedGoals: agentPlansData.filter((p) => p.status === "failed").length,
        };
      });

      const pendingQueueDepth = activeGoals.reduce(
        (sum, goal) => sum + goal.progress.pending + goal.progress.running,
        0,
      );
      const tenMinutesAgo = Date.now() - 10 * 60_000;
      const failuresLast10m = allPlans.filter((plan) => {
        if (plan.status !== "failed") return false;
        const updatedAt = new Date(plan.updatedAt).getTime();
        return Number.isFinite(updatedAt) && updatedAt >= tenMinutesAgo;
      }).length;
      const workersActive = agentStates.filter(
        (agent) => agent.currentGoal && agent.status !== "paused",
      ).length;
      const loopState = goalStats.active > 0
        ? failuresLast10m > 0 ? "degraded" : "running"
        : "idle";
      const queueState = pendingQueueDepth === 0
        ? "healthy"
        : pendingQueueDepth >= 12 ? "backlogged" : "normal";

      const systemStatus = {
        loopState,
        queueState,
        queueDepth: pendingQueueDepth,
        workersActive,
        failuresLast10m,
      };

      // Engine status
      const capabilities = detectCapabilities();
      const registry = getEngineRegistry();
      const categories = listEnginesByCategory();

      const engineStatus = {
        capabilities,
        engines: Object.values(registry).map((e) => ({
          name: e.name,
          kind: e.type,
          enabled: e.enabled,
        })),
        categories,
      };

      res.json({
        goalStats,
        activeGoals,
        recentGoals,
        agentStates,
        engineStatus,
        systemStatus,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Internal error";
      logger.error({ err }, "AI dashboard route error");
      res.status(500).json({ error: message });
    }
  });

  // -----------------------------------------------------------------------
  // GET /companies/:companyId/ai/dashboard/events   (SSE)
  // Real-time AI event stream via Server-Sent Events.
  // -----------------------------------------------------------------------
  router.get("/companies/:companyId/ai/dashboard/events", (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);

    // SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // disable nginx buffering
    });
    res.flushHeaders();

    // Send initial connection event
    res.write(`data: ${JSON.stringify({ type: "connected", companyId })}\n\n`);

    // Heartbeat to keep connection alive
    const heartbeatInterval = setInterval(() => {
      res.write(`: heartbeat\n\n`);
    }, 15_000);

    // Subscribe to AI events
    const unsubscribes: Array<() => void> = [];
    for (const eventName of AI_EVENTS) {
      const unsub = eventBus.subscribe(eventName, (event: PaperclipEvent) => {
        // Only relay events for this company
        const payload = event.payload as Record<string, unknown>;
        if (payload.companyId && payload.companyId !== companyId) return;

        const sseData = {
          type: event.name,
          timestamp: event.timestamp,
          ...payload,
        };
        res.write(`event: ${event.name}\ndata: ${JSON.stringify(sseData)}\n\n`);
      });
      unsubscribes.push(unsub);
    }

    // Cleanup on client disconnect
    req.on("close", () => {
      clearInterval(heartbeatInterval);
      for (const unsub of unsubscribes) unsub();
      logger.debug({ companyId }, "SSE client disconnected from AI dashboard");
    });
  });

  // -----------------------------------------------------------------------
  // POST /companies/:companyId/ai/goals/:goalId/retry
  // Retry the last failed step in a goal. Resets the step to "pending".
  // -----------------------------------------------------------------------
  router.post("/companies/:companyId/ai/goals/:goalId/retry", async (req, res) => {
    try {
      const { companyId, goalId } = req.params;
      assertCompanyAccess(req, companyId);

      const store = planStore(db);
      const plan = await store.getPlanScoped(goalId, companyId);

      if (!plan) {
        res.status(404).json({ error: "Goal not found" });
        return;
      }

      if (plan.status !== "failed") {
        res.status(409).json({ error: "Only failed goals can be retried" });
        return;
      }

      const graph = plan.graphJson as unknown as TaskGraph;
      if (!graph?.steps) {
        res.status(422).json({ error: "Invalid plan graph" });
        return;
      }

      // Find the last failed step
      const failedStep = [...graph.steps].reverse().find((s) => s.status === "failed");
      if (!failedStep) {
        res.status(422).json({ error: "No failed step found to retry" });
        return;
      }

      // Reset the failed step
      const updatedGraph = resetStepForRetry(graph, failedStep.id);

      // Re-activate the plan
      await store.updatePlanGraph(plan.id, updatedGraph, {
        stepsCompleted: getGraphProgress(updatedGraph).completed,
        iterationsUsed: plan.iterationsUsed,
      });
      await store.updatePlanStatus(plan.id, "active");

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: "dashboard",
        action: "ai.goal.retried",
        entityType: "agent",
        entityId: plan.agentId,
        details: { planId: goalId, retriedStep: failedStep.id },
      });

      logger.info({ goalId, stepId: failedStep.id }, "Goal step retried from dashboard");
      res.json({ status: "active", planId: goalId, retriedStep: failedStep.id });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Internal error";
      logger.error({ err }, "Goal retry route error");
      res.status(500).json({ error: message });
    }
  });

  // -----------------------------------------------------------------------
  // POST /companies/:companyId/ai/goals/:goalId/reassign
  // Reassign a goal (active or failed) to a different agent.
  // -----------------------------------------------------------------------
  router.post("/companies/:companyId/ai/goals/:goalId/reassign", async (req, res) => {
    try {
      const { companyId, goalId } = req.params;
      const { agentId: newAgentId } = req.body as { agentId?: string };
      assertCompanyAccess(req, companyId);

      if (!newAgentId) {
        res.status(400).json({ error: "agentId is required" });
        return;
      }

      // Verify the target agent exists and belongs to this company
      const [targetAgent] = await db
        .select()
        .from(agents)
        .where(and(eq(agents.id, newAgentId), eq(agents.companyId, companyId)));

      if (!targetAgent) {
        res.status(404).json({ error: "Target agent not found" });
        return;
      }

      const store = planStore(db);
      const plan = await store.getPlanScoped(goalId, companyId);

      if (!plan) {
        res.status(404).json({ error: "Goal not found" });
        return;
      }

      if (plan.status !== "active" && plan.status !== "failed") {
        res.status(409).json({ error: "Only active or failed goals can be reassigned" });
        return;
      }

      // Cancel old goal if running
      const orchestrator = agentOrchestrator(db);
      if (orchestrator.isGoalRunning(goalId)) {
        orchestrator.cancelGoal(goalId);
      }

      // Update the plan's agent
      const previousAgentId = plan.agentId;
      await db
        .update(agentPlans)
        .set({
          agentId: newAgentId,
          status: "active",
          updatedAt: new Date(),
        })
        .where(and(eq(agentPlans.id, goalId), eq(agentPlans.companyId, companyId)));

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: "dashboard",
        action: "ai.goal.reassigned",
        entityType: "agent",
        entityId: newAgentId,
        details: {
          planId: goalId,
          previousAgentId,
          newAgentId,
        },
      });

      logger.info({ goalId, previousAgentId, newAgentId }, "Goal reassigned from dashboard");
      res.json({
        status: "active",
        planId: goalId,
        previousAgentId,
        newAgentId,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Internal error";
      logger.error({ err }, "Goal reassign route error");
      res.status(500).json({ error: message });
    }
  });

  // -----------------------------------------------------------------------
  // GET /companies/:companyId/ai/goals/:goalId/memory
  // Get episodic memory entries for a goal.
  // -----------------------------------------------------------------------
  router.get("/companies/:companyId/ai/goals/:goalId/memory", async (req, res) => {
    try {
      const { companyId, goalId } = req.params;
      assertCompanyAccess(req, companyId);

      const store = planStore(db);
      const plan = await store.getPlanScoped(goalId, companyId);

      if (!plan) {
        res.status(404).json({ error: "Goal not found" });
        return;
      }

      const episodes = Array.isArray(plan.episodicJson) ? plan.episodicJson : [];
      const graph = plan.graphJson as unknown as TaskGraph;
      const steps = graph?.steps ?? [];

      res.json({
        planId: goalId,
        issueId: plan.issueId,
        agentId: plan.agentId,
        status: plan.status,
        iterationsUsed: plan.iterationsUsed,
        maxIterations: plan.maxIterations,
        goal: plan.goal,
        episodes,
        steps: steps.map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description,
          dependsOn: s.dependsOn,
          status: s.status,
          retries: s.retries,
          maxRetries: s.maxRetries,
          toolName: s.toolName,
          toolArgs: s.toolArgs,
          output: s.output,
          error: s.error,
        })),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Internal error";
      logger.error({ err }, "Goal memory route error");
      res.status(500).json({ error: message });
    }
  });

  return router;
}
