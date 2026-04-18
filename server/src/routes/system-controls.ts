import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  resolveSystemDecisionSchema,
  updateSystemControlsSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import {
  getSystemControls,
  updateSystemControls,
  listSystemDecisions,
  getSystemDecisionById,
  resolveSystemDecision,
  setSystemDecisionExecutionResult,
} from "../services/system-controls.js";
import { executeDecisionActionNow } from "../ai/governance/decisionEngine.js";
import { logActivity } from "../services/activity-log.js";
import { listCompanyCycleState } from "../services/cycle-state.js";
import {
  listExecutionFeed,
  toExecutionFeedEventFromLivePayload,
  type ExecutionFeedCategory,
  type ExecutionFeedStatus,
} from "../services/execution-feed.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";

function coerceLimit(raw: unknown, fallback = 100): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(500, Math.trunc(value)));
}

function parseCsvValues(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

const EXECUTION_FEED_CATEGORIES = new Set<ExecutionFeedCategory>([
  "traffic",
  "email",
  "decision",
  "execution",
  "revenue",
  "system",
]);

const EXECUTION_FEED_STATUSES = new Set<ExecutionFeedStatus>([
  "info",
  "success",
  "failed",
  "pending",
  "blocked",
  "skipped",
]);

export function systemControlsRoutes(db: Db) {
  const router = Router();

  router.get("/companies/:companyId/system-controls", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const controls = await getSystemControls(db, companyId);
    res.json(controls);
  });

  router.get("/companies/:companyId/cycle-state", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const rows = await listCompanyCycleState(db, companyId);
    res.json(rows);
  });

  router.get("/companies/:companyId/execution-feed", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const limit = coerceLimit(req.query.limit, 120);
    const categories = parseCsvValues(req.query.categories).filter(
      (value): value is ExecutionFeedCategory => EXECUTION_FEED_CATEGORIES.has(value as ExecutionFeedCategory),
    );
    const statuses = parseCsvValues(req.query.statuses).filter(
      (value): value is ExecutionFeedStatus => EXECUTION_FEED_STATUSES.has(value as ExecutionFeedStatus),
    );

    const events = await listExecutionFeed(db, companyId, {
      limit,
      categories: categories.length > 0 ? categories : undefined,
      statuses: statuses.length > 0 ? statuses : undefined,
    });
    res.json(events);
  });

  router.get("/companies/:companyId/execution-feed/stream", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const limit = coerceLimit(req.query.limit, 80);
    const categories = parseCsvValues(req.query.categories).filter(
      (value): value is ExecutionFeedCategory => EXECUTION_FEED_CATEGORIES.has(value as ExecutionFeedCategory),
    );
    const statuses = parseCsvValues(req.query.statuses).filter(
      (value): value is ExecutionFeedStatus => EXECUTION_FEED_STATUSES.has(value as ExecutionFeedStatus),
    );

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();

    const initial = await listExecutionFeed(db, companyId, {
      limit,
      categories: categories.length > 0 ? categories : undefined,
      statuses: statuses.length > 0 ? statuses : undefined,
    });
    res.write(`event: snapshot\ndata: ${JSON.stringify(initial)}\n\n`);

    const keepAlive = setInterval(() => {
      res.write(`: heartbeat\n\n`);
    }, 15_000);

    const unsubscribe = subscribeCompanyLiveEvents(companyId, (event) => {
      if (event.type !== "activity.logged") return;

      const payload = event.payload ?? {};
      const action = typeof payload.action === "string" ? payload.action : null;
      if (!action) return;

      const feedEvent = toExecutionFeedEventFromLivePayload({
        companyId,
        action,
        details: payload.details,
        timestamp: event.createdAt,
      });
      if (categories.length > 0 && !categories.includes(feedEvent.category)) return;
      if (statuses.length > 0 && !statuses.includes(feedEvent.status)) return;

      res.write(`event: update\ndata: ${JSON.stringify(feedEvent)}\n\n`);
    });

    req.on("close", () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
  });

  router.patch(
    "/companies/:companyId/system-controls",
    validate(updateSystemControlsSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const updated = await updateSystemControls(db, companyId, req.body);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "system.controls.updated",
        entityType: "company",
        entityId: companyId,
        details: req.body,
      });

      res.json(updated);
    },
  );

  router.get("/companies/:companyId/decisions", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const limit = coerceLimit(req.query.limit, 100);
    const decisions = await listSystemDecisions(db, companyId, limit);
    res.json(decisions);
  });

  router.post(
    "/companies/:companyId/decisions/:decisionId/approve",
    validate(resolveSystemDecisionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const decisionId = req.params.decisionId as string;
      assertCompanyAccess(req, companyId);

      const actor = getActorInfo(req);
      const decision = await getSystemDecisionById(db, companyId, decisionId);
      if (!decision) {
        res.status(404).json({ error: "Decision not found" });
        return;
      }

      if (!["pending", "awaiting_approval", "approved"].includes(decision.status)) {
        res.status(409).json({ error: `Decision cannot be approved from status ${decision.status}` });
        return;
      }

      const resolved = await resolveSystemDecision(db, companyId, decisionId, {
        resolution: "approve",
        actorId: actor.actorId,
        note: req.body.note ?? null,
      });

      if (!resolved) {
        res.status(404).json({ error: "Decision not found" });
        return;
      }

      const actionPayload = (resolved.actionPayload ?? {}) as Record<string, unknown>;
      const actionResult = await executeDecisionActionNow(db, companyId, {
        type: resolved.actionType as "create_issue" | "update_strategy" | "trigger_expansion" | "run_traffic_cycle",
        key: resolved.actionKey,
        reason: resolved.reason,
        payload: actionPayload,
      }, "approval", decisionId);

      await setSystemDecisionExecutionResult(db, companyId, decisionId, {
        status: actionResult.success ? "executed" : "failed",
        note: actionResult.error ?? null,
      });

      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "system.decision.approved",
        entityType: "company",
        entityId: companyId,
        details: {
          decisionId,
          actionKey: resolved.actionKey,
          actionType: resolved.actionType,
          executed: actionResult.success,
          decisionMode: "approved",
          error: actionResult.error ?? null,
        },
      });

      res.json({
        decision: await getSystemDecisionById(db, companyId, decisionId),
        execution: actionResult,
      });
    },
  );

  router.post(
    "/companies/:companyId/decisions/:decisionId/reject",
    validate(resolveSystemDecisionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const decisionId = req.params.decisionId as string;
      assertCompanyAccess(req, companyId);

      const actor = getActorInfo(req);
      const decision = await getSystemDecisionById(db, companyId, decisionId);
      if (!decision) {
        res.status(404).json({ error: "Decision not found" });
        return;
      }

      const rejected = await resolveSystemDecision(db, companyId, decisionId, {
        resolution: "reject",
        actorId: actor.actorId,
        note: req.body.note ?? null,
      });

      await setSystemDecisionExecutionResult(db, companyId, decisionId, {
        status: "overridden",
        note: req.body.note ?? "rejected by operator",
      });

      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "system.decision.rejected",
        entityType: "company",
        entityId: companyId,
        details: {
          decisionId,
          note: req.body.note ?? null,
          actionKey: rejected?.actionKey ?? null,
          actionType: rejected?.actionType ?? null,
        },
      });

      res.json(await getSystemDecisionById(db, companyId, decisionId));
    },
  );

  return router;
}
