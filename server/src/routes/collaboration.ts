// ---------------------------------------------------------------------------
// Collaboration Routes — Multi-Agent Collaboration System API
// ---------------------------------------------------------------------------

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { eq, and } from "@paperclipai/db";
import { getAllRoles, getRoleDefinition, canRoleHandleTask } from "../ai/agents/roleRegistry.js";
import { loadCompanyProfiles, loadAgentProfile, findDelegator } from "../ai/agents/agentProfiles.js";
import { delegateTask, delegateWithFallback } from "../ai/coordination/taskDelegator.js";
import { routeTask, getHierarchy } from "../ai/coordination/agentRouter.js";
import { sendAgentMessage, getUnreadMessages, broadcastToCompany } from "../ai/coordination/agentMessenger.js";
import {
  buildCollaborationPlan,
  autoCollaborationPlan,
  classifyGoalTasks,
} from "../ai/collaboration/collaborationPlanner.js";
import { validateDependencies, getMaxParallelism, getExecutionLevels } from "../ai/collaboration/dependencyResolver.js";
import { checkBudget, getCompanyBudgetSummary, recordSpending, canAfford } from "../ai/governance/agentBudget.js";
import {
  checkApproval,
  approveAction,
  rejectAction,
  listPendingApprovals,
  getApproval,
  getApprovalLevel,
} from "../ai/governance/approvalGate.js";
import pino from "pino";

const logger = pino({ name: "collaboration-routes" });

export function collaborationRoutes(db: Db) {
  const router = Router();

  // -----------------------------------------------------------------------
  // Role Registry
  // -----------------------------------------------------------------------

  /** GET /companies/:companyId/collaboration/roles — list all role definitions */
  router.get("/companies/:companyId/collaboration/roles", async (_req, res) => {
    res.json(getAllRoles());
  });

  /** GET /companies/:companyId/collaboration/roles/:role — get single role definition */
  router.get("/companies/:companyId/collaboration/roles/:role", async (req, res) => {
    const def = getRoleDefinition(req.params.role);
    res.json(def);
  });

  // -----------------------------------------------------------------------
  // Agent Profiles
  // -----------------------------------------------------------------------

  /** GET /companies/:companyId/collaboration/profiles — list agent profiles */
  router.get("/companies/:companyId/collaboration/profiles", async (req, res) => {
    try {
      const profiles = await loadCompanyProfiles(db, req.params.companyId);
      res.json(profiles);
    } catch (err) {
      logger.error({ err }, "Failed to load profiles");
      res.status(500).json({ error: "Failed to load agent profiles" });
    }
  });

  /** GET /companies/:companyId/collaboration/profiles/:agentId — single profile */
  router.get("/companies/:companyId/collaboration/profiles/:agentId", async (req, res) => {
    try {
      const profile = await loadAgentProfile(db, req.params.agentId);
      if (!profile || profile.companyId !== req.params.companyId) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }
      res.json(profile);
    } catch (err) {
      logger.error({ err }, "Failed to load profile");
      res.status(500).json({ error: "Failed to load agent profile" });
    }
  });

  /** GET /companies/:companyId/collaboration/hierarchy — org chart */
  router.get("/companies/:companyId/collaboration/hierarchy", async (req, res) => {
    try {
      const hierarchy = await getHierarchy(db, req.params.companyId);
      res.json(hierarchy);
    } catch (err) {
      logger.error({ err }, "Failed to load hierarchy");
      res.status(500).json({ error: "Failed to load hierarchy" });
    }
  });

  // -----------------------------------------------------------------------
  // Task Delegation
  // -----------------------------------------------------------------------

  /** POST /companies/:companyId/collaboration/delegate — delegate a task */
  router.post("/companies/:companyId/collaboration/delegate", async (req, res) => {
    const { fromAgentId, taskType, goal, issueId, preferredAgentId, context } = req.body;
    if (!fromAgentId || !taskType || !goal) {
      res.status(400).json({ error: "fromAgentId, taskType, and goal are required" });
      return;
    }
    try {
      const result = await delegateTask(db, {
        companyId: req.params.companyId,
        fromAgentId,
        taskType,
        goal,
        issueId,
        preferredAgentId,
        context,
      });
      res.json(result);
    } catch (err) {
      logger.error({ err }, "Delegation failed");
      res.status(500).json({ error: "Task delegation failed" });
    }
  });

  /** POST /companies/:companyId/collaboration/delegate-fallback — delegate with agent failure fallback */
  router.post("/companies/:companyId/collaboration/delegate-fallback", async (req, res) => {
    const { fromAgentId, taskType, goal, issueId, preferredAgentId, context, failedAgentIds } = req.body;
    if (!fromAgentId || !taskType || !goal) {
      res.status(400).json({ error: "fromAgentId, taskType, and goal are required" });
      return;
    }
    try {
      const result = await delegateWithFallback(db, {
        companyId: req.params.companyId,
        fromAgentId,
        taskType,
        goal,
        issueId,
        preferredAgentId,
        context,
      }, failedAgentIds ?? []);
      res.json(result);
    } catch (err) {
      logger.error({ err }, "Fallback delegation failed");
      res.status(500).json({ error: "Fallback delegation failed" });
    }
  });

  /** POST /companies/:companyId/collaboration/route — route a task to best agent */
  router.post("/companies/:companyId/collaboration/route", async (req, res) => {
    const { taskType, requiredCapabilities, excludeAgentIds } = req.body;
    if (!taskType) {
      res.status(400).json({ error: "taskType is required" });
      return;
    }
    try {
      const result = await routeTask(db, {
        companyId: req.params.companyId,
        taskType,
        requiredCapabilities,
        excludeAgentIds,
      });
      res.json(result);
    } catch (err) {
      logger.error({ err }, "Routing failed");
      res.status(500).json({ error: "Task routing failed" });
    }
  });

  // -----------------------------------------------------------------------
  // Agent Messaging
  // -----------------------------------------------------------------------

  /** POST /companies/:companyId/collaboration/messages — send a message */
  router.post("/companies/:companyId/collaboration/messages", async (req, res) => {
    const { fromAgentId, toAgentId, message, messageType } = req.body;
    if (!fromAgentId || !toAgentId || !message) {
      res.status(400).json({ error: "fromAgentId, toAgentId, and message are required" });
      return;
    }
    try {
      const result = await sendAgentMessage(db, {
        companyId: req.params.companyId,
        fromAgentId,
        toAgentId,
        message,
        messageType: messageType ?? "information",
      });
      res.json(result);
    } catch (err) {
      logger.error({ err }, "Message send failed");
      res.status(500).json({ error: "Failed to send message" });
    }
  });

  /** GET /companies/:companyId/collaboration/messages/unread/:agentId — unread messages */
  router.get("/companies/:companyId/collaboration/messages/unread/:agentId", async (req, res) => {
    try {
      const messages = await getUnreadMessages(db, req.params.agentId, req.params.companyId);
      res.json(messages);
    } catch (err) {
      logger.error({ err }, "Failed to get unread messages");
      res.status(500).json({ error: "Failed to get unread messages" });
    }
  });

  /** POST /companies/:companyId/collaboration/messages/broadcast — broadcast to all agents */
  router.post("/companies/:companyId/collaboration/messages/broadcast", async (req, res) => {
    const { fromAgentId, message, messageType } = req.body;
    if (!fromAgentId || !message) {
      res.status(400).json({ error: "fromAgentId and message are required" });
      return;
    }
    try {
      const messages = await broadcastToCompany(
        db,
        req.params.companyId,
        fromAgentId,
        message,
        messageType ?? "information",
      );
      res.json({ sent: messages.length, messages });
    } catch (err) {
      logger.error({ err }, "Broadcast failed");
      res.status(500).json({ error: "Broadcast failed" });
    }
  });

  // -----------------------------------------------------------------------
  // Collaboration Planning
  // -----------------------------------------------------------------------

  /** POST /companies/:companyId/collaboration/plan — build a multi-agent plan */
  router.post("/companies/:companyId/collaboration/plan", async (req, res) => {
    const { goal, tasks, issueId, initiatorAgentId } = req.body;
    if (!goal || !tasks || !Array.isArray(tasks)) {
      res.status(400).json({ error: "goal and tasks (array) are required" });
      return;
    }
    try {
      const result = await buildCollaborationPlan(db, {
        companyId: req.params.companyId,
        goal,
        tasks,
        issueId,
        initiatorAgentId,
      });

      // Validate dependencies
      const depIssues = validateDependencies(result.graph);
      const parallelism = getMaxParallelism(result.graph);
      const levels = getExecutionLevels(result.graph);

      res.json({
        ...result,
        validation: {
          valid: depIssues.length === 0,
          issues: depIssues,
        },
        execution: {
          maxParallelism: parallelism,
          levelCount: levels.length,
          levels: levels.map((lvl) => lvl.map((s) => ({ id: s.id, name: s.name }))),
        },
      });
    } catch (err) {
      logger.error({ err }, "Collaboration plan failed");
      res.status(500).json({ error: "Failed to build collaboration plan" });
    }
  });

  /** POST /companies/:companyId/collaboration/auto-plan — auto-generate plan from goal */
  router.post("/companies/:companyId/collaboration/auto-plan", async (req, res) => {
    const { goal, issueId } = req.body;
    if (!goal) {
      res.status(400).json({ error: "goal is required" });
      return;
    }
    try {
      const result = await autoCollaborationPlan(db, req.params.companyId, goal, issueId);

      const depIssues = validateDependencies(result.graph);
      const parallelism = getMaxParallelism(result.graph);

      res.json({
        ...result,
        taskTypes: classifyGoalTasks(goal),
        validation: { valid: depIssues.length === 0, issues: depIssues },
        execution: { maxParallelism: parallelism },
      });
    } catch (err) {
      logger.error({ err }, "Auto collaboration plan failed");
      res.status(500).json({ error: "Failed to auto-generate collaboration plan" });
    }
  });

  /** POST /companies/:companyId/collaboration/classify — classify a goal into task types */
  router.post("/companies/:companyId/collaboration/classify", async (req, res) => {
    const { goal } = req.body;
    if (!goal) {
      res.status(400).json({ error: "goal is required" });
      return;
    }
    res.json({ goal, taskTypes: classifyGoalTasks(goal) });
  });

  // -----------------------------------------------------------------------
  // Budget Management
  // -----------------------------------------------------------------------

  /** GET /companies/:companyId/collaboration/budget — company budget summary */
  router.get("/companies/:companyId/collaboration/budget", async (req, res) => {
    try {
      const summary = await getCompanyBudgetSummary(db, req.params.companyId);
      res.json(summary);
    } catch (err) {
      logger.error({ err }, "Failed to get budget summary");
      res.status(500).json({ error: "Failed to get budget summary" });
    }
  });

  /** GET /companies/:companyId/collaboration/budget/:agentId — agent budget status */
  router.get("/companies/:companyId/collaboration/budget/:agentId", async (req, res) => {
    try {
      const status = await checkBudget(db, req.params.agentId);
      res.json(status);
    } catch (err) {
      logger.error({ err }, "Failed to check budget");
      res.status(500).json({ error: "Failed to check budget" });
    }
  });

  /** POST /companies/:companyId/collaboration/budget/:agentId/spend — record spending */
  router.post("/companies/:companyId/collaboration/budget/:agentId/spend", async (req, res) => {
    const { costCents } = req.body;
    if (typeof costCents !== "number" || costCents < 0) {
      res.status(400).json({ error: "costCents (positive number) is required" });
      return;
    }
    try {
      const result = await recordSpending(db, req.params.agentId, costCents);
      res.json(result);
    } catch (err) {
      logger.error({ err }, "Failed to record spending");
      res.status(500).json({ error: "Failed to record spending" });
    }
  });

  // -----------------------------------------------------------------------
  // Approval Gates
  // -----------------------------------------------------------------------

  /** GET /companies/:companyId/collaboration/approvals — list pending approvals */
  router.get("/companies/:companyId/collaboration/approvals", async (_req, res) => {
    const pending = listPendingApprovals(_req.params.companyId);
    res.json(pending);
  });

  /** GET /companies/:companyId/collaboration/approvals/:approvalId — get approval details */
  router.get("/companies/:companyId/collaboration/approvals/:approvalId", async (req, res) => {
    const approval = getApproval(req.params.approvalId);
    if (!approval || approval.companyId !== req.params.companyId) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    res.json(approval);
  });

  /** POST /companies/:companyId/collaboration/approvals/:approvalId/approve */
  router.post("/companies/:companyId/collaboration/approvals/:approvalId/approve", async (req, res) => {
    const { approvedBy } = req.body;
    try {
      const result = await approveAction(db, req.params.approvalId, approvedBy ?? "board");
      if (!result.success) {
        res.status(400).json({ error: result.reason });
        return;
      }
      res.json(result);
    } catch (err) {
      logger.error({ err }, "Approve failed");
      res.status(500).json({ error: "Failed to approve" });
    }
  });

  /** POST /companies/:companyId/collaboration/approvals/:approvalId/reject */
  router.post("/companies/:companyId/collaboration/approvals/:approvalId/reject", async (req, res) => {
    const { rejectedBy, reason } = req.body;
    try {
      const result = await rejectAction(db, req.params.approvalId, rejectedBy ?? "board", reason);
      if (!result.success) {
        res.status(400).json({ error: result.reason });
        return;
      }
      res.json(result);
    } catch (err) {
      logger.error({ err }, "Reject failed");
      res.status(500).json({ error: "Failed to reject" });
    }
  });

  /** POST /companies/:companyId/collaboration/approvals/check — check if action needs approval */
  router.post("/companies/:companyId/collaboration/approvals/check", async (req, res) => {
    const { agentId, action, description } = req.body;
    if (!agentId || !action) {
      res.status(400).json({ error: "agentId and action are required" });
      return;
    }
    try {
      const result = await checkApproval(
        db,
        agentId,
        req.params.companyId,
        action,
        description ?? action,
      );
      res.json({
        ...result,
        approvalLevel: getApprovalLevel(action),
      });
    } catch (err) {
      logger.error({ err }, "Approval check failed");
      res.status(500).json({ error: "Failed to check approval" });
    }
  });

  return router;
}
