// ---------------------------------------------------------------------------
// Governance Routes — System Stability & Safety Dashboard
// ---------------------------------------------------------------------------

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  requestGovernanceClearance,
  getGovernanceAudit,
  getGovernanceStats,
  clearGovernanceAudit,
  resetCircuitBreakers,
} from "../ai/governance/governanceEngine.js";
import {
  peekRateLimit,
  getAllRateLimits,
  getRateLimitStats,
  clearRateLimits,
} from "../ai/governance/systemRateLimiter.js";
import {
  createSandboxExecution,
  recordTestResults,
  promoteExecution,
  rejectExecution,
  getExecution,
  listExecutions,
  getSandboxStats,
  getPromotionGates,
} from "../ai/governance/executionSandbox.js";
import {
  evaluateCompanyROI,
  evaluateEcosystemHealth,
  runCompanyFeedback,
  getPendingFeedbackActions,
  getCompanyROIHistory,
  getAgentProductivityHistory,
  evaluateAgentProductivity,
  getFeedbackConfig,
  setFeedbackConfig,
} from "../ai/governance/economicFeedbackLoop.js";
import {
  getRecentSystemMetricsSnapshot,
  listRecentSystemMetrics,
} from "../ai/feedback/metricsEngine.js";
import { runAutonomousDecisionCycle } from "../ai/governance/decisionEngine.js";
import {
  getAutonomyLimits,
  getAutonomyLimitsSnapshot,
  setAutonomyLimits,
  resetAutonomyLimits,
} from "../ai/governance/autonomyLimits.js";
import { getGoalContainmentStats } from "../ai/governance/goalContainment.js";
import {
  evaluateGovernanceRules,
  type RuleActionContext,
} from "../ai/governance/ruleEnforcement.js";
import {
  queryKnowledge,
  getKnowledgeByCategory,
  buildKnowledgeContext,
  type KnowledgeCategory,
} from "../ai/governance/knowledgeRetrieval.js";
import { executePlaybook } from "../ai/governance/playbookEngine.js";
import {
  governanceRuleService,
  institutionalKnowledgeService,
  organizationalPlaybookService,
  logActivity,
} from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import type { GovernedActionType } from "../ai/governance/governanceEngine.js";
import type { RateLimitDomain } from "../ai/governance/systemRateLimiter.js";

export function governanceRoutes(db: Db) {
  const r = Router();

  // Global governance surfaces are board-only. Company-scoped governance APIs
  // continue to use assertCompanyAccess per-route.
  r.use("/governance", (req, res, next) => {
    try {
      assertBoard(req);
      next();
    } catch (err) {
      next(err);
    }
  });

  // =========================================================================
  // Central Governance Engine
  // =========================================================================

  /** Request governance clearance for an action */
  r.post("/governance/clearance", async (req, res, next) => {
    try {
      const { action, actorType, actorId, companyId, agentId, estimatedCostCents, metadata } = req.body;
      if (!action || !actorType || !actorId || !companyId) {
        res.status(400).json({ error: "action, actorType, actorId, and companyId are required" });
        return;
      }
      const decision = await requestGovernanceClearance(db, {
        action: action as GovernedActionType,
        actorType,
        actorId,
        companyId,
        agentId,
        estimatedCostCents,
        metadata,
      });
      res.json(decision);
    } catch (err) {
      next(err);
    }
  });

  /** Get governance audit trail */
  r.get("/governance/audit", (_req, res) => {
    const companyId = _req.query.companyId as string | undefined;
    const limit = _req.query.limit ? Number(_req.query.limit) : undefined;
    res.json(getGovernanceAudit(companyId, limit));
  });

  /** Get governance stats */
  r.get("/governance/stats", (_req, res) => {
    res.json(getGovernanceStats());
  });

  /** Reset circuit breakers (admin action) */
  r.post("/governance/circuit-breakers/reset", (_req, res) => {
    resetCircuitBreakers();
    res.json({ success: true });
  });

  // =========================================================================
  // System Rate Limiter
  // =========================================================================

  /** Get all rate limit configurations */
  r.get("/governance/rate-limits", (_req, res) => {
    res.json(getAllRateLimits());
  });

  /** Get rate limit stats */
  r.get("/governance/rate-limits/stats", (_req, res) => {
    res.json(getRateLimitStats());
  });

  /** Peek at remaining capacity for a rate limit */
  r.get("/governance/rate-limits/:domain/peek", (req, res) => {
    const { domain } = req.params;
    const companyId = req.query.companyId as string;
    const agentId = req.query.agentId as string | undefined;
    if (!companyId) {
      res.status(400).json({ error: "companyId query parameter is required" });
      return;
    }
    res.json(peekRateLimit(domain as RateLimitDomain, companyId, agentId));
  });

  // =========================================================================
  // Execution Sandboxing
  // =========================================================================

  /** Get promotion gates */
  r.get("/governance/sandbox/gates", (_req, res) => {
    res.json(getPromotionGates());
  });

  /** Get sandbox stats */
  r.get("/governance/sandbox/stats", (_req, res) => {
    res.json(getSandboxStats());
  });

  /** List sandbox executions */
  r.get("/governance/sandbox/executions", (req, res) => {
    const companyId = req.query.companyId as string | undefined;
    res.json(listExecutions(companyId));
  });

  /** Create sandbox execution */
  r.post("/governance/sandbox/executions", (req, res) => {
    const { companyId, action, agentId } = req.body;
    if (!companyId || !action) {
      res.status(400).json({ error: "companyId and action are required" });
      return;
    }
    const execution = createSandboxExecution(companyId, action, agentId);
    res.status(201).json(execution);
  });

  /** Get sandbox execution by ID */
  r.get("/governance/sandbox/executions/:id", (req, res) => {
    const execution = getExecution(req.params.id);
    if (!execution) {
      res.status(404).json({ error: "Execution not found" });
      return;
    }
    res.json(execution);
  });

  /** Record test results for a sandbox execution */
  r.post("/governance/sandbox/executions/:id/test-results", (req, res) => {
    const { results } = req.body;
    if (!results || !Array.isArray(results)) {
      res.status(400).json({ error: "results array is required" });
      return;
    }
    const execution = recordTestResults(req.params.id, results);
    if (!execution) {
      res.status(404).json({ error: "Execution not found" });
      return;
    }
    res.json(execution);
  });

  /** Promote a sandbox execution to next environment */
  r.post("/governance/sandbox/executions/:id/promote", (req, res) => {
    const { promotedBy } = req.body;
    const result = promoteExecution(req.params.id, promotedBy);
    if (!result.success) {
      res.status(400).json({ error: result.reason });
      return;
    }
    res.json(result.execution);
  });

  /** Reject a sandbox execution */
  r.post("/governance/sandbox/executions/:id/reject", (req, res) => {
    const { rejectedBy, reason } = req.body;
    if (!rejectedBy || !reason) {
      res.status(400).json({ error: "rejectedBy and reason are required" });
      return;
    }
    const result = rejectExecution(req.params.id, rejectedBy, reason);
    if (!result.success) {
      res.status(404).json({ error: result.reason });
      return;
    }
    res.json({ success: true });
  });

  // =========================================================================
  // Economic Feedback Loop
  // =========================================================================

  /** Get feedback loop config */
  r.get("/governance/feedback/config", (_req, res) => {
    res.json(getFeedbackConfig());
  });

  /** Update feedback loop config */
  r.patch("/governance/feedback/config", (req, res) => {
    setFeedbackConfig(req.body);
    res.json(getFeedbackConfig());
  });

  /** Evaluate ROI for a company */
  r.get("/governance/feedback/company/:companyId/roi", (req, res) => {
    res.json(evaluateCompanyROI(req.params.companyId));
  });

  /** Run feedback loop for a company */
  r.post("/governance/feedback/company/:companyId/evaluate", (req, res) => {
    const action = runCompanyFeedback(req.params.companyId);
    res.json(action);
  });

  /** Get ROI history for a company */
  r.get("/governance/feedback/company/:companyId/history", (req, res) => {
    res.json(getCompanyROIHistory(req.params.companyId));
  });

  /** Evaluate agent productivity */
  r.get("/governance/feedback/agent/:agentId/productivity", (req, res) => {
    const companyId = req.query.companyId as string;
    if (!companyId) {
      res.status(400).json({ error: "companyId query parameter is required" });
      return;
    }
    res.json(evaluateAgentProductivity(req.params.agentId, companyId));
  });

  /** Get agent productivity history */
  r.get("/governance/feedback/agent/:agentId/history", (req, res) => {
    res.json(getAgentProductivityHistory(req.params.agentId));
  });

  /** Evaluate entire ecosystem health */
  r.post("/governance/feedback/ecosystem", (req, res) => {
    const { companyIds } = req.body;
    if (!companyIds || !Array.isArray(companyIds)) {
      res.status(400).json({ error: "companyIds array is required" });
      return;
    }
    res.json(evaluateEcosystemHealth(companyIds));
  });

  /** Get pending feedback actions */
  r.get("/governance/feedback/actions", (req, res) => {
    const companyId = req.query.companyId as string | undefined;
    res.json(getPendingFeedbackActions(companyId));
  });

  /** Get recent system metrics snapshot for a company */
  r.get("/companies/:companyId/governance/system-metrics", async (req, res, next) => {
    try {
      const { companyId } = req.params;
      assertCompanyAccess(req, companyId);
      const windowMinutes = req.query.windowMinutes ? Number(req.query.windowMinutes) : 180;
      const snapshot = await getRecentSystemMetricsSnapshot(db, companyId, windowMinutes);
      const recent = await listRecentSystemMetrics(db, companyId, 50);
      res.json({ snapshot, recent });
    } catch (err) {
      next(err);
    }
  });

  /** Manually trigger decision cycle using current metric snapshot */
  r.post("/companies/:companyId/governance/decision-cycle", async (req, res, next) => {
    try {
      const { companyId } = req.params;
      assertCompanyAccess(req, companyId);
      const windowMinutes = req.body?.windowMinutes ? Number(req.body.windowMinutes) : 180;
      const snapshot = await getRecentSystemMetricsSnapshot(db, companyId, windowMinutes);
      const result = await runAutonomousDecisionCycle(db, {
        companyId,
        metrics: snapshot,
        source: "manual",
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // =========================================================================
  // Global Autonomy Limits
  // =========================================================================

  /** Get current autonomy limits */
  r.get("/governance/limits", (_req, res) => {
    res.json(getAutonomyLimitsSnapshot());
  });

  /** Override specific autonomy limits (admin only) */
  r.patch("/governance/limits", (req, res) => {
    const overrides = req.body;
    if (!overrides || typeof overrides !== "object") {
      res.status(400).json({ error: "Provide limit overrides as JSON object" });
      return;
    }
    setAutonomyLimits(overrides);
    res.json({ updated: true, limits: getAutonomyLimitsSnapshot() });
  });

  /** Reset autonomy limits to env/defaults */
  r.post("/governance/limits/reset", (_req, res) => {
    resetAutonomyLimits();
    res.json({ reset: true, limits: getAutonomyLimitsSnapshot() });
  });

  // =========================================================================
  // Goal Containment
  // =========================================================================

  /** Get goal containment stats for a company */
  r.get("/companies/:companyId/governance/goal-containment", async (req, res, next) => {
    try {
      const { companyId } = req.params;
      assertCompanyAccess(req, companyId);
      const stats = await getGoalContainmentStats(db, companyId);
      res.json(stats);
    } catch (err) {
      next(err);
    }
  });

  // =========================================================================
  // Unified Governance Dashboard
  // =========================================================================

  /** Get full governance dashboard — single endpoint for all safety metrics */
  r.get("/governance/dashboard", (_req, res) => {
    res.json({
      governance: getGovernanceStats(),
      rateLimits: getRateLimitStats(),
      sandbox: getSandboxStats(),
      feedbackConfig: getFeedbackConfig(),
      pendingActions: getPendingFeedbackActions(),
      autonomyLimits: getAutonomyLimitsSnapshot(),
    });
  });

  // =========================================================================
  // Constitutional Governance — Rules
  // =========================================================================

  const ruleSvc = governanceRuleService(db);

  /** List governance rules for a company */
  r.get("/companies/:companyId/governance/rules", async (req, res, next) => {
    try {
      const { companyId } = req.params;
      assertCompanyAccess(req, companyId);
      const rules = await ruleSvc.list(companyId);
      res.json(rules);
    } catch (err) {
      next(err);
    }
  });

  /** Create a governance rule */
  r.post("/companies/:companyId/governance/rules", async (req, res, next) => {
    try {
      const { companyId } = req.params;
      assertCompanyAccess(req, companyId);
      const rule = await ruleSvc.create(companyId, req.body);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "governance.rule.created",
        entityType: "governance_rule",
        entityId: rule.id,
        details: { ruleName: rule.ruleName, ruleType: rule.ruleType },
      });
      res.status(201).json(rule);
    } catch (err) {
      next(err);
    }
  });

  /** Update a governance rule */
  r.patch("/companies/:companyId/governance/rules/:ruleId", async (req, res, next) => {
    try {
      const { companyId, ruleId } = req.params;
      assertCompanyAccess(req, companyId);
      const rule = await ruleSvc.update(ruleId, req.body);
      if (!rule) {
        res.status(404).json({ error: "Rule not found" });
        return;
      }
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "governance.rule.updated",
        entityType: "governance_rule",
        entityId: rule.id,
        details: req.body,
      });
      res.json(rule);
    } catch (err) {
      next(err);
    }
  });

  /** Delete a governance rule */
  r.delete("/companies/:companyId/governance/rules/:ruleId", async (req, res, next) => {
    try {
      const { companyId, ruleId } = req.params;
      assertCompanyAccess(req, companyId);
      const rule = await ruleSvc.remove(ruleId);
      if (!rule) {
        res.status(404).json({ error: "Rule not found" });
        return;
      }
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "governance.rule.deleted",
        entityType: "governance_rule",
        entityId: rule.id,
        details: { ruleName: rule.ruleName },
      });
      res.json({ deleted: true });
    } catch (err) {
      next(err);
    }
  });

  // =========================================================================
  // Institutional Knowledge
  // =========================================================================

  const knowledgeSvc = institutionalKnowledgeService(db);

  /** List institutional knowledge for a company */
  r.get("/companies/:companyId/governance/knowledge", async (req, res, next) => {
    try {
      const { companyId } = req.params;
      assertCompanyAccess(req, companyId);
      const records = await knowledgeSvc.list(companyId);
      res.json(records);
    } catch (err) {
      next(err);
    }
  });

  /** Create institutional knowledge entry */
  r.post("/companies/:companyId/governance/knowledge", async (req, res, next) => {
    try {
      const { companyId } = req.params;
      assertCompanyAccess(req, companyId);
      const record = await knowledgeSvc.create(companyId, req.body);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "governance.knowledge.created",
        entityType: "institutional_knowledge",
        entityId: record.id,
        details: { title: record.title, category: record.category },
      });
      res.status(201).json(record);
    } catch (err) {
      next(err);
    }
  });

  /** Approve institutional knowledge entry */
  r.post("/companies/:companyId/governance/knowledge/:knowledgeId/approve", async (req, res, next) => {
    try {
      const { companyId, knowledgeId } = req.params;
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);
      const record = await knowledgeSvc.approve(knowledgeId, actor.actorId);
      if (!record) {
        res.status(404).json({ error: "Knowledge entry not found" });
        return;
      }
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "governance.knowledge.approved",
        entityType: "institutional_knowledge",
        entityId: record.id,
        details: { title: record.title },
      });
      res.json(record);
    } catch (err) {
      next(err);
    }
  });

  /** Delete institutional knowledge entry */
  r.delete("/companies/:companyId/governance/knowledge/:knowledgeId", async (req, res, next) => {
    try {
      const { companyId, knowledgeId } = req.params;
      assertCompanyAccess(req, companyId);
      const record = await knowledgeSvc.remove(knowledgeId);
      if (!record) {
        res.status(404).json({ error: "Knowledge entry not found" });
        return;
      }
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "governance.knowledge.deleted",
        entityType: "institutional_knowledge",
        entityId: record.id,
        details: { title: record.title },
      });
      res.json({ deleted: true });
    } catch (err) {
      next(err);
    }
  });

  // =========================================================================
  // Organizational Playbooks
  // =========================================================================

  const playbookSvc = organizationalPlaybookService(db);

  /** List playbooks for a company */
  r.get("/companies/:companyId/governance/playbooks", async (req, res, next) => {
    try {
      const { companyId } = req.params;
      assertCompanyAccess(req, companyId);
      const playbooks = await playbookSvc.list(companyId);
      res.json(playbooks);
    } catch (err) {
      next(err);
    }
  });

  /** Create a playbook */
  r.post("/companies/:companyId/governance/playbooks", async (req, res, next) => {
    try {
      const { companyId } = req.params;
      assertCompanyAccess(req, companyId);
      const playbook = await playbookSvc.create(companyId, req.body);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "governance.playbook.created",
        entityType: "organizational_playbook",
        entityId: playbook.id,
        details: { title: playbook.title, category: playbook.category },
      });
      res.status(201).json(playbook);
    } catch (err) {
      next(err);
    }
  });

  /** Update a playbook */
  r.patch("/companies/:companyId/governance/playbooks/:playbookId", async (req, res, next) => {
    try {
      const { companyId, playbookId } = req.params;
      assertCompanyAccess(req, companyId);
      const playbook = await playbookSvc.update(playbookId, req.body);
      if (!playbook) {
        res.status(404).json({ error: "Playbook not found" });
        return;
      }
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "governance.playbook.updated",
        entityType: "organizational_playbook",
        entityId: playbook.id,
        details: req.body,
      });
      res.json(playbook);
    } catch (err) {
      next(err);
    }
  });

  /** Apply a playbook (increment counter + log) */
  r.post("/companies/:companyId/governance/playbooks/:playbookId/apply", async (req, res, next) => {
    try {
      const { companyId, playbookId } = req.params;
      assertCompanyAccess(req, companyId);
      const playbook = await playbookSvc.apply(playbookId);
      if (!playbook) {
        res.status(404).json({ error: "Playbook not found" });
        return;
      }
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "governance.playbook.applied",
        entityType: "organizational_playbook",
        entityId: playbook.id,
        details: { title: playbook.title, timesApplied: playbook.timesApplied },
      });
      res.json(playbook);
    } catch (err) {
      next(err);
    }
  });

  /** Delete a playbook */
  r.delete("/companies/:companyId/governance/playbooks/:playbookId", async (req, res, next) => {
    try {
      const { companyId, playbookId } = req.params;
      assertCompanyAccess(req, companyId);
      const playbook = await playbookSvc.remove(playbookId);
      if (!playbook) {
        res.status(404).json({ error: "Playbook not found" });
        return;
      }
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "governance.playbook.deleted",
        entityType: "organizational_playbook",
        entityId: playbook.id,
        details: { title: playbook.title },
      });
      res.json({ deleted: true });
    } catch (err) {
      next(err);
    }
  });

  // =========================================================================
  // Governance Rule Enforcement Engine
  // =========================================================================

  /** Evaluate governance rules for a proposed action */
  r.post("/companies/:companyId/governance/evaluate", async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const { action, context } = req.body;
      if (!action) {
        res.status(400).json({ error: "action is required" });
        return;
      }
      const actor = getActorInfo(req);
      const decision = await evaluateGovernanceRules(db, {
        companyId,
        action: action as RuleActionContext,
        actorId: actor.actorId,
        context: context ?? {},
      });
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: decision.allowed ? "governance.rule.evaluated" : "governance.rule.blocked",
        entityType: "governance_rule",
        entityId: companyId,
        details: {
          ruleAction: action,
          allowed: decision.allowed,
          blockedCount: decision.blockedBy.length,
          warningCount: decision.warnings.length,
        },
      });
      res.json(decision);
    } catch (err) {
      next(err);
    }
  });

  // =========================================================================
  // Institutional Knowledge Retrieval
  // =========================================================================

  /** Query knowledge relevant to a task/context */
  r.post("/companies/:companyId/governance/knowledge/query", async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const { taskContext, categories, tags, limit } = req.body;
      if (!taskContext) {
        res.status(400).json({ error: "taskContext is required" });
        return;
      }
      const actor = getActorInfo(req);
      const result = await queryKnowledge(db, {
        companyId,
        requesterId: actor.actorId,
        taskContext,
        categories,
        tags,
        limit,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  /** Get all knowledge in a specific category */
  r.get("/companies/:companyId/governance/knowledge/category/:category", async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const category = req.params.category as KnowledgeCategory;
      const entries = await getKnowledgeByCategory(db, companyId, category);
      res.json(entries);
    } catch (err) {
      next(err);
    }
  });

  /** Build a knowledge context string for agent prompts */
  r.post("/companies/:companyId/governance/knowledge/context", async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const { taskContext } = req.body;
      if (!taskContext) {
        res.status(400).json({ error: "taskContext is required" });
        return;
      }
      const actor = getActorInfo(req);
      const context = await buildKnowledgeContext(db, companyId, actor.actorId, taskContext);
      res.json({ context });
    } catch (err) {
      next(err);
    }
  });

  // =========================================================================
  // Playbook Execution Engine
  // =========================================================================

  /** Execute a playbook — creates issues from playbook steps */
  r.post("/companies/:companyId/governance/playbooks/:playbookId/execute", async (req, res, next) => {
    try {
      const { companyId, playbookId } = req.params;
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);
      const { projectId, goalId, assigneeAgentId } = req.body;
      const result = await executePlaybook(db, {
        companyId,
        playbookId,
        triggeredBy: actor.actorId,
        projectId,
        goalId,
        assigneeAgentId,
      });
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "governance.playbook.executed",
        entityType: "organizational_playbook",
        entityId: playbookId,
        details: {
          playbookTitle: result.playbookTitle,
          stepsCreated: result.stepsCreated,
          stepsFailed: result.stepsFailed,
        },
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  return r;
}
