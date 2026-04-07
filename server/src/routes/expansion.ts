// ---------------------------------------------------------------------------
// Expansion Routes — Autonomous Agent Creation & Organizational Expansion API
// ---------------------------------------------------------------------------

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { analyzeCapabilityGaps, canHandleTask, analyzeGoalGaps } from "../ai/expansion/capabilityGapAnalyzer.js";
import { designAgents } from "../ai/expansion/agentDesigner.js";
import { getCompanyDepartments, planDepartments, createDepartment } from "../ai/expansion/departmentPlanner.js";
import { generateRoles, validateRole, toRoleDefinition } from "../ai/creation/roleGenerator.js";
import { createAgent, createAgents } from "../ai/creation/agentFactory.js";
import {
  submitExpansionRequest,
  approveExpansion,
  rejectExpansion,
  completeExpansion,
  listPendingRequests,
  listExpansionRequests,
  determineApprovalLevel,
} from "../ai/governance/expansionApproval.js";
import { checkWorkforceStatus, canCreateAgent, canCreateDepartment, getWorkforceLimits } from "../ai/governance/workforceLimits.js";
import { checkRateLimit } from "../ai/governance/systemRateLimiter.js";
import { requestGovernanceClearance } from "../ai/governance/governanceEngine.js";
import pino from "pino";

const logger = pino({ name: "expansion-routes" });

export function expansionRoutes(db: Db) {
  const router = Router();

  // -----------------------------------------------------------------------
  // Capability Gap Analysis
  // -----------------------------------------------------------------------

  /** GET /companies/:companyId/expansion/gaps — analyse capability gaps */
  router.get("/companies/:companyId/expansion/gaps", async (req, res) => {
    try {
      const result = await analyzeCapabilityGaps(db, req.params.companyId);
      res.json(result);
    } catch (err: unknown) {
      logger.error({ err }, "Gap analysis failed");
      res.status(500).json({ error: "Gap analysis failed" });
    }
  });

  /** POST /companies/:companyId/expansion/gaps/task — check if a task can be handled */
  router.post("/companies/:companyId/expansion/gaps/task", async (req, res) => {
    try {
      const { taskType, requiredCapabilities } = req.body;
      if (!taskType) {
        res.status(400).json({ error: "taskType is required" });
        return;
      }
      const result = await canHandleTask(db, req.params.companyId, taskType, requiredCapabilities);
      res.json(result);
    } catch (err: unknown) {
      logger.error({ err }, "Task capability check failed");
      res.status(500).json({ error: "Task capability check failed" });
    }
  });

  /** POST /companies/:companyId/expansion/gaps/goal — analyse gaps for a goal */
  router.post("/companies/:companyId/expansion/gaps/goal", async (req, res) => {
    try {
      const { taskTypes } = req.body;
      if (!taskTypes || !Array.isArray(taskTypes)) {
        res.status(400).json({ error: "taskTypes array is required" });
        return;
      }
      const gaps = await analyzeGoalGaps(db, req.params.companyId, taskTypes);
      res.json({ gaps });
    } catch (err: unknown) {
      logger.error({ err }, "Goal gap analysis failed");
      res.status(500).json({ error: "Goal gap analysis failed" });
    }
  });

  // -----------------------------------------------------------------------
  // Agent Design
  // -----------------------------------------------------------------------

  /** POST /companies/:companyId/expansion/design — design agents for gaps */
  router.post("/companies/:companyId/expansion/design", async (req, res) => {
    try {
      const { gaps } = req.body;
      if (!gaps || !Array.isArray(gaps)) {
        // Auto-analyze if no gaps provided
        const analysis = await analyzeCapabilityGaps(db, req.params.companyId);
        const result = await designAgents(db, req.params.companyId, analysis.gaps);
        res.json(result);
        return;
      }
      const result = await designAgents(db, req.params.companyId, gaps);
      res.json(result);
    } catch (err: unknown) {
      logger.error({ err }, "Agent design failed");
      res.status(500).json({ error: "Agent design failed" });
    }
  });

  // -----------------------------------------------------------------------
  // Departments
  // -----------------------------------------------------------------------

  /** GET /companies/:companyId/expansion/departments — list departments */
  router.get("/companies/:companyId/expansion/departments", async (req, res) => {
    try {
      const depts = await getCompanyDepartments(db, req.params.companyId);
      res.json({ departments: depts });
    } catch (err: unknown) {
      logger.error({ err }, "List departments failed");
      res.status(500).json({ error: "List departments failed" });
    }
  });

  /** POST /companies/:companyId/expansion/departments/plan — plan department structure */
  router.post("/companies/:companyId/expansion/departments/plan", async (req, res) => {
    try {
      const plan = await planDepartments(db, req.params.companyId);
      res.json(plan);
    } catch (err: unknown) {
      logger.error({ err }, "Department planning failed");
      res.status(500).json({ error: "Department planning failed" });
    }
  });

  /** POST /companies/:companyId/expansion/departments — create a department */
  router.post("/companies/:companyId/expansion/departments", async (req, res) => {
    try {
      const allowed = await canCreateDepartment(db, req.params.companyId);
      if (!allowed.allowed) {
        res.status(422).json({ error: allowed.reason });
        return;
      }
      const { name, description, headAgentId, parentDepartmentId, capabilities } = req.body;
      if (!name) {
        res.status(400).json({ error: "name is required" });
        return;
      }
      const dept = await createDepartment(db, req.params.companyId, {
        name,
        description,
        headAgentId,
        capabilities,
      });
      res.status(201).json(dept);
    } catch (err: unknown) {
      logger.error({ err }, "Department creation failed");
      res.status(500).json({ error: "Department creation failed" });
    }
  });

  // -----------------------------------------------------------------------
  // Workforce Limits
  // -----------------------------------------------------------------------

  /** GET /companies/:companyId/expansion/limits — get workforce status and limits */
  router.get("/companies/:companyId/expansion/limits", async (req, res) => {
    try {
      const status = await checkWorkforceStatus(db, req.params.companyId);
      res.json(status);
    } catch (err: unknown) {
      logger.error({ err }, "Workforce status check failed");
      res.status(500).json({ error: "Workforce status check failed" });
    }
  });

  // -----------------------------------------------------------------------
  // Expansion Requests (approval workflow)
  // -----------------------------------------------------------------------

  /** GET /companies/:companyId/expansion/requests — list expansion requests */
  router.get("/companies/:companyId/expansion/requests", async (req, res) => {
    try {
      const status = req.query.status as string | undefined;
      const requests = await listExpansionRequests(db, req.params.companyId, status as any);
      res.json({ requests });
    } catch (err: unknown) {
      logger.error({ err }, "List expansion requests failed");
      res.status(500).json({ error: "List expansion requests failed" });
    }
  });

  /** GET /companies/:companyId/expansion/requests/pending — list pending requests */
  router.get("/companies/:companyId/expansion/requests/pending", async (req, res) => {
    try {
      const requests = await listPendingRequests(db, req.params.companyId);
      res.json({ requests });
    } catch (err: unknown) {
      logger.error({ err }, "List pending requests failed");
      res.status(500).json({ error: "List pending requests failed" });
    }
  });

  /** POST /companies/:companyId/expansion/requests/:requestId/approve — approve */
  router.post("/companies/:companyId/expansion/requests/:requestId/approve", async (req, res) => {
    try {
      const success = await approveExpansion(db, req.params.requestId, req.params.companyId, req.body.approvedBy);
      if (!success) {
        res.status(404).json({ error: "Request not found or not pending" });
        return;
      }
      res.json({ approved: true });
    } catch (err: unknown) {
      logger.error({ err }, "Approve expansion failed");
      res.status(500).json({ error: "Approve expansion failed" });
    }
  });

  /** POST /companies/:companyId/expansion/requests/:requestId/reject — reject */
  router.post("/companies/:companyId/expansion/requests/:requestId/reject", async (req, res) => {
    try {
      const { reason, rejectedBy } = req.body;
      if (!reason) {
        res.status(400).json({ error: "reason is required" });
        return;
      }
      const success = await rejectExpansion(db, req.params.requestId, req.params.companyId, reason, rejectedBy);
      if (!success) {
        res.status(404).json({ error: "Request not found or not pending" });
        return;
      }
      res.json({ rejected: true });
    } catch (err: unknown) {
      logger.error({ err }, "Reject expansion failed");
      res.status(500).json({ error: "Reject expansion failed" });
    }
  });

  // -----------------------------------------------------------------------
  // Full Expansion Pipeline (analyse → design → approve → create)
  // -----------------------------------------------------------------------

  /** POST /companies/:companyId/expansion/expand — run full expansion pipeline */
  router.post("/companies/:companyId/expansion/expand", async (req, res) => {
    try {
      const companyId = req.params.companyId;

      // 0. Governance gate — central clearance for agent creation
      const governance = await requestGovernanceClearance(db, {
        action: "expand_workforce",
        actorType: req.body.requestedBy ? "board" : "agent",
        actorId: req.body.requestedBy ?? "system",
        companyId,
        agentId: req.body.requestedBy,
      });
      if (!governance.allowed) {
        res.status(422).json({ error: "Governance blocked", reason: governance.reason, blockedBy: governance.blockedBy, traceId: governance.traceId });
        return;
      }

      // 0b. Rate limit check
      const rl = checkRateLimit("agent_creation", companyId);
      if (!rl.allowed) {
        res.status(429).json({ error: "Rate limit exceeded", reason: rl.reason });
        return;
      }

      // 1. Check limits
      const status = await checkWorkforceStatus(db, companyId);
      if (!status.canExpand) {
        res.status(422).json({ error: "Workforce limits reached", violations: status.violations });
        return;
      }

      // 2. Analyse gaps
      const analysis = await analyzeCapabilityGaps(db, companyId);
      if (analysis.gaps.length === 0) {
        res.json({ expanded: false, reason: "No capability gaps found", analysis });
        return;
      }

      // 3. Design agents
      const design = await designAgents(db, companyId, analysis.gaps);
      if (design.designs.length === 0) {
        res.json({ expanded: false, reason: "No agents designed", analysis });
        return;
      }

      // 4. Submit requests & create auto-approved agents
      const results = [];
      for (const spec of design.designs) {
        // Check per-agent budget limit
        const allowed = await canCreateAgent(db, companyId, spec.budgetCents);
        if (!allowed.allowed) {
          results.push({ role: spec.role, created: false, reason: allowed.reason });
          continue;
        }

        const gap = analysis.gaps.find((g) => g.suggestedRole === spec.role) ?? null;
        const request = await submitExpansionRequest(db, companyId, spec, gap, req.body.requestedBy);

        if (request.status === "approved") {
          const creationResult = await createAgent(db, { companyId, design: spec, expansionRequestId: request.id });
          if (creationResult.success && creationResult.agentId) {
            await completeExpansion(db, request.id, companyId, creationResult.agentId);
          }
          results.push({ role: spec.role, created: creationResult.success, agentId: creationResult.agentId, requestId: request.id });
        } else {
          results.push({ role: spec.role, created: false, status: request.status, approvalLevel: request.approvalLevel, requestId: request.id });
        }
      }

      res.json({
        expanded: true,
        gapsFound: analysis.gaps.length,
        agentsDesigned: design.designs.length,
        results,
      });
    } catch (err: unknown) {
      logger.error({ err }, "Full expansion pipeline failed");
      res.status(500).json({ error: "Expansion pipeline failed" });
    }
  });

  return router;
}
