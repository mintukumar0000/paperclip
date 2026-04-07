// ---------------------------------------------------------------------------
// Learning Routes — Self-Improving AI Layer API (Phase 22)
// ---------------------------------------------------------------------------

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { evaluateOutcome } from "../ai/evaluation/outcomeEvaluator.js";
import { scoreQuality, aggregateQualityScores } from "../ai/evaluation/qualityScorer.js";
import { analyzePerformance, analyzeAgentPerformance } from "../ai/learning/performanceAnalyzer.js";
import { reflect, reflectOnGoal } from "../ai/learning/reflectionEngine.js";
import { planImprovements, getUnappliedPlans, markPlanApplied, rollbackPlan } from "../ai/learning/improvementPlanner.js";
import { optimizePrompt, getPromptHistory } from "../ai/optimization/promptOptimizer.js";
import { optimizeWorkflow, getWorkflowOptimizationHistory } from "../ai/optimization/workflowOptimizer.js";
import { optimizeStrategy, classifyGoalType, getStrategyHistory } from "../ai/optimization/strategyOptimizer.js";
import { aiLearningRecords } from "@paperclipai/db";
import { eq, and, desc } from "@paperclipai/db";
import pino from "pino";

const logger = pino({ name: "learning-routes" });

export function learningRoutes(db: Db) {
  const router = Router();

  // -----------------------------------------------------------------------
  // Outcome Evaluation
  // -----------------------------------------------------------------------

  /** POST /companies/:companyId/learning/evaluate — evaluate a goal outcome */
  router.post("/companies/:companyId/learning/evaluate", async (req, res) => {
    const { goalId, success, startedAt, completedAt, totalSteps, completedSteps, failedSteps, totalCostCents, agentIds, errors } = req.body;
    if (!goalId) {
      res.status(400).json({ error: "goalId is required" });
      return;
    }
    try {
      const result = await evaluateOutcome(db, {
        goalId,
        companyId: req.params.companyId,
        success: success ?? false,
        startedAt: new Date(startedAt ?? Date.now()),
        completedAt: new Date(completedAt ?? Date.now()),
        totalSteps: totalSteps ?? 0,
        completedSteps: completedSteps ?? 0,
        failedSteps: failedSteps ?? 0,
        totalCostCents: totalCostCents ?? 0,
        agentIds: agentIds ?? [],
        errors: errors ?? [],
      });
      res.json(result);
    } catch (err) {
      logger.error({ err }, "Evaluation failed");
      res.status(500).json({ error: "Failed to evaluate outcome" });
    }
  });

  // -----------------------------------------------------------------------
  // Quality Scoring
  // -----------------------------------------------------------------------

  /** POST /companies/:companyId/learning/quality — score agent quality */
  router.post("/companies/:companyId/learning/quality", async (req, res) => {
    const { goalId, agentId, taskType, output, stepCount, completedSteps, failedSteps, executionTimeMs, costCents } = req.body;
    if (!goalId || !agentId || !taskType) {
      res.status(400).json({ error: "goalId, agentId, and taskType are required" });
      return;
    }
    try {
      const result = await scoreQuality(db, {
        goalId,
        companyId: req.params.companyId,
        agentId,
        taskType,
        output: output ?? "",
        stepCount: stepCount ?? 0,
        completedSteps: completedSteps ?? 0,
        failedSteps: failedSteps ?? 0,
        executionTimeMs: executionTimeMs ?? 0,
        costCents: costCents ?? 0,
      });
      res.json(result);
    } catch (err) {
      logger.error({ err }, "Quality scoring failed");
      res.status(500).json({ error: "Failed to score quality" });
    }
  });

  // -----------------------------------------------------------------------
  // Performance Analysis
  // -----------------------------------------------------------------------

  /** GET /companies/:companyId/learning/performance — company performance report */
  router.get("/companies/:companyId/learning/performance", async (req, res) => {
    try {
      const report = await analyzePerformance(db, req.params.companyId);
      res.json(report);
    } catch (err) {
      logger.error({ err }, "Performance analysis failed");
      res.status(500).json({ error: "Failed to analyze performance" });
    }
  });

  /** GET /companies/:companyId/learning/performance/:agentId — agent performance */
  router.get("/companies/:companyId/learning/performance/:agentId", async (req, res) => {
    try {
      const summary = await analyzeAgentPerformance(db, req.params.companyId, req.params.agentId);
      if (!summary) {
        res.json({ agentId: req.params.agentId, message: "No performance data available" });
        return;
      }
      res.json(summary);
    } catch (err) {
      logger.error({ err }, "Agent performance analysis failed");
      res.status(500).json({ error: "Failed to analyze agent performance" });
    }
  });

  // -----------------------------------------------------------------------
  // Reflection Engine
  // -----------------------------------------------------------------------

  /** POST /companies/:companyId/learning/reflect — run full reflection */
  router.post("/companies/:companyId/learning/reflect", async (req, res) => {
    try {
      const result = await reflect(db, req.params.companyId);
      res.json(result);
    } catch (err) {
      logger.error({ err }, "Reflection failed");
      res.status(500).json({ error: "Failed to run reflection" });
    }
  });

  // -----------------------------------------------------------------------
  // Improvement Planning
  // -----------------------------------------------------------------------

  /** POST /companies/:companyId/learning/improve — generate improvement plans from reflections */
  router.post("/companies/:companyId/learning/improve", async (req, res) => {
    try {
      // First run reflection to get insights
      const reflectionResult = await reflect(db, req.params.companyId);
      const result = await planImprovements(db, req.params.companyId, reflectionResult.reflections);
      res.json(result);
    } catch (err) {
      logger.error({ err }, "Improvement planning failed");
      res.status(500).json({ error: "Failed to plan improvements" });
    }
  });

  /** GET /companies/:companyId/learning/improvements — list unapplied plans */
  router.get("/companies/:companyId/learning/improvements", async (req, res) => {
    try {
      const plans = await getUnappliedPlans(db, req.params.companyId);
      res.json(plans);
    } catch (err) {
      logger.error({ err }, "Failed to list improvements");
      res.status(500).json({ error: "Failed to list improvements" });
    }
  });

  /** POST /companies/:companyId/learning/improvements/:planId/apply — apply an improvement */
  router.post("/companies/:companyId/learning/improvements/:planId/apply", async (req, res) => {
    try {
      const applied = await markPlanApplied(db, req.params.planId, req.params.companyId);
      if (!applied) {
        res.status(404).json({ error: "Improvement plan not found" });
        return;
      }
      res.json({ success: true, planId: req.params.planId });
    } catch (err) {
      logger.error({ err }, "Failed to apply improvement");
      res.status(500).json({ error: "Failed to apply improvement" });
    }
  });

  /** POST /companies/:companyId/learning/improvements/:planId/rollback — rollback an improvement */
  router.post("/companies/:companyId/learning/improvements/:planId/rollback", async (req, res) => {
    try {
      const rolled = await rollbackPlan(db, req.params.planId, req.params.companyId);
      if (!rolled) {
        res.status(404).json({ error: "Applied plan not found" });
        return;
      }
      res.json({ success: true, planId: req.params.planId, rolledBack: true });
    } catch (err) {
      logger.error({ err }, "Failed to rollback improvement");
      res.status(500).json({ error: "Failed to rollback improvement" });
    }
  });

  // -----------------------------------------------------------------------
  // Prompt Optimization
  // -----------------------------------------------------------------------

  /** POST /companies/:companyId/learning/optimize/prompt — optimize an agent's prompt */
  router.post("/companies/:companyId/learning/optimize/prompt", async (req, res) => {
    const { agentId, taskType, currentPrompt } = req.body;
    if (!agentId || !taskType || !currentPrompt) {
      res.status(400).json({ error: "agentId, taskType, and currentPrompt are required" });
      return;
    }
    try {
      const result = await optimizePrompt(db, req.params.companyId, agentId, taskType, currentPrompt);
      res.json(result);
    } catch (err) {
      logger.error({ err }, "Prompt optimization failed");
      res.status(500).json({ error: "Failed to optimize prompt" });
    }
  });

  /** GET /companies/:companyId/learning/optimize/prompt/:agentId/history — prompt optimization history */
  router.get("/companies/:companyId/learning/optimize/prompt/:agentId/history", async (req, res) => {
    try {
      const history = await getPromptHistory(db, req.params.companyId, req.params.agentId);
      res.json(history);
    } catch (err) {
      logger.error({ err }, "Failed to get prompt history");
      res.status(500).json({ error: "Failed to get prompt history" });
    }
  });

  // -----------------------------------------------------------------------
  // Workflow Optimization
  // -----------------------------------------------------------------------

  /** POST /companies/:companyId/learning/optimize/workflow — optimize a workflow */
  router.post("/companies/:companyId/learning/optimize/workflow", async (req, res) => {
    const { steps } = req.body;
    if (!steps || !Array.isArray(steps)) {
      res.status(400).json({ error: "steps (array) is required" });
      return;
    }
    try {
      const result = await optimizeWorkflow(db, req.params.companyId, steps);
      res.json(result);
    } catch (err) {
      logger.error({ err }, "Workflow optimization failed");
      res.status(500).json({ error: "Failed to optimize workflow" });
    }
  });

  /** GET /companies/:companyId/learning/optimize/workflow/history — workflow optimization history */
  router.get("/companies/:companyId/learning/optimize/workflow/history", async (req, res) => {
    try {
      const history = await getWorkflowOptimizationHistory(db, req.params.companyId);
      res.json(history);
    } catch (err) {
      logger.error({ err }, "Failed to get workflow history");
      res.status(500).json({ error: "Failed to get workflow history" });
    }
  });

  // -----------------------------------------------------------------------
  // Strategy Optimization
  // -----------------------------------------------------------------------

  /** POST /companies/:companyId/learning/optimize/strategy — optimize a strategy */
  router.post("/companies/:companyId/learning/optimize/strategy", async (req, res) => {
    const { goal, currentStrategy } = req.body;
    if (!goal) {
      res.status(400).json({ error: "goal is required" });
      return;
    }
    try {
      const goalType = classifyGoalType(goal);
      const strategy = currentStrategy ?? [{ phase: "Execute", description: goal, importance: "critical" as const }];
      const result = await optimizeStrategy(db, req.params.companyId, goalType, strategy);
      res.json(result);
    } catch (err) {
      logger.error({ err }, "Strategy optimization failed");
      res.status(500).json({ error: "Failed to optimize strategy" });
    }
  });

  /** GET /companies/:companyId/learning/optimize/strategy/history — strategy optimization history */
  router.get("/companies/:companyId/learning/optimize/strategy/history", async (req, res) => {
    try {
      const history = await getStrategyHistory(db, req.params.companyId);
      res.json(history);
    } catch (err) {
      logger.error({ err }, "Failed to get strategy history");
      res.status(500).json({ error: "Failed to get strategy history" });
    }
  });

  // -----------------------------------------------------------------------
  // Learning Records (raw access)
  // -----------------------------------------------------------------------

  /** GET /companies/:companyId/learning/records — list recent learning records */
  router.get("/companies/:companyId/learning/records", async (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const type = req.query.type as string | undefined;

      const conditions = [eq(aiLearningRecords.companyId, req.params.companyId)];
      if (type) {
        conditions.push(eq(aiLearningRecords.recordType, type));
      }

      const records = await db
        .select()
        .from(aiLearningRecords)
        .where(and(...conditions))
        .orderBy(desc(aiLearningRecords.createdAt))
        .limit(limit);

      res.json({ count: records.length, records });
    } catch (err) {
      logger.error({ err }, "Failed to list learning records");
      res.status(500).json({ error: "Failed to list learning records" });
    }
  });

  // -----------------------------------------------------------------------
  // Full Learning Cycle
  // -----------------------------------------------------------------------

  /** POST /companies/:companyId/learning/cycle — run the complete learning cycle */
  router.post("/companies/:companyId/learning/cycle", async (req, res) => {
    const companyId = req.params.companyId;
    try {
      // Step 1: Performance analysis
      const performance = await analyzePerformance(db, companyId);

      // Step 2: Reflection
      const reflectionResult = await reflect(db, companyId);

      // Step 3: Improvement planning
      const improvements = await planImprovements(db, companyId, reflectionResult.reflections);

      res.json({
        performance: {
          overallScore: performance.overallScore,
          insightCount: performance.insights.length,
          agentCount: performance.agentPerformance.length,
        },
        reflection: {
          reflectionCount: reflectionResult.reflections.length,
          categories: [...new Set(reflectionResult.reflections.map((r) => r.category))],
        },
        improvements: {
          totalPlans: improvements.plans.length,
          autoApplicable: improvements.autoApplicable.length,
          needsApproval: improvements.needsApproval.length,
        },
        generatedAt: new Date(),
      });
    } catch (err) {
      logger.error({ err }, "Learning cycle failed");
      res.status(500).json({ error: "Failed to run learning cycle" });
    }
  });

  return router;
}
