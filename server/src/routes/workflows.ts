import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { workflowEngine } from "../workflows/workflowEngine.js";
import { logActivity } from "../services/index.js";

export function workflowRoutes(db: Db) {
  const router = Router();
  const engine = workflowEngine(db);

  /** List workflows for a company */
  router.get("/companies/:companyId/workflows", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await engine.listWorkflows(companyId);
    res.json(result);
  });

  /** Create a new workflow */
  router.post("/companies/:companyId/workflows", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const { name, description, definition } = req.body;
    if (!name || !definition) {
      res.status(400).json({ error: "name and definition are required" });
      return;
    }

    const workflow = await engine.createWorkflow(companyId, {
      name,
      description,
      definition,
    });

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "workflow.created",
      entityType: "workflow",
      entityId: workflow.id,
      details: { name },
    });

    res.status(201).json(workflow);
  });

  /** Trigger a workflow run */
  router.post("/workflows/:workflowId/trigger", async (req, res) => {
    const workflowId = req.params.workflowId as string;
    const { context } = req.body;

    const run = await engine.triggerWorkflow(workflowId, context ?? {});
    res.status(201).json(run);
  });

  /** List workflow runs for a company */
  router.get("/companies/:companyId/workflow-runs", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await engine.listRuns(companyId);
    res.json(result);
  });

  return router;
}
