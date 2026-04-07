// ---------------------------------------------------------------------------
// Simulation Engine — Orchestrates Simulation Runs
// ---------------------------------------------------------------------------
// The main entry point for the simulation system. Coordinates:
//   - Environment creation
//   - Scenario execution (single or multiple strategies)
//   - Result persistence
//   - Strategy evaluation and selection
//
// Sits between Strategy and Execution in the architecture:
//   Constitution/Governance → Strategy → Simulation → Agent Planning → Execution
// ---------------------------------------------------------------------------

import type { Db } from "@paperclipai/db";
import { eq, sql } from "@paperclipai/db";
import { simulationRuns, simulationScenarios } from "@paperclipai/db";
import pino from "pino";
import { eventBus } from "../../events/eventBus.js";
import {
  runScenario,
  createCompanyLaunchScenario,
  createHiringScenario,
  createPricingScenario,
  type ScenarioConfig,
  type ScenarioResult,
  type ScenarioType,
} from "./scenarioRunner.js";
import { evaluateStrategies, isStrategyDeployable, type StrategyComparison } from "./simulationEvaluator.js";
import { assessStability } from "../stability/ecosystemStabilityController.js";
import { recordSystemMetric, getRecentSystemMetricsSnapshot } from "../feedback/metricsEngine.js";
import { runAutonomousDecisionCycle, type DecisionCycleResult } from "../governance/decisionEngine.js";

const logger = pino({ name: "sim-engine" });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SimulationRequest {
  companyId: string;
  scenarioType: ScenarioType;
  strategies: Array<{
    name: string;
    variables: Record<string, number | string>;
  }>;
  simulatedDays?: number;
  requestedBy: string;
}

export interface SimulationRunResult {
  runId: string;
  status: "completed" | "failed";
  scenarioType: ScenarioType;
  strategyResults: ScenarioResult[];
  evaluation: StrategyComparison;
  selectedStrategy: string;
  deployable: boolean;
  deployReason?: string;
  decision?: DecisionCycleResult;
  executionTimeMs: number;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * Run a full simulation comparing multiple strategies.
 * This is the primary API for the simulation layer.
 *
 * Flow:
 *   1. Stability check — refuse if ecosystem is unstable
 *   2. Create simulation run record in DB
 *   3. Generate scenario configs for each strategy
 *   4. Execute all scenarios
 *   5. Evaluate and rank strategies
 *   6. Select the best deployable strategy
 *   7. Persist results and emit events
 */
export async function runSimulation(
  db: Db,
  request: SimulationRequest,
): Promise<SimulationRunResult> {
  const start = Date.now();

  // 1. Stability gate — check if we should even be simulating
  const stability = await assessStability(db);
  if (stability.action === "emergency_stop") {
    throw new Error("Simulation blocked: ecosystem in emergency state");
  }

  // 2. Create run record
  const [run] = await db
    .insert(simulationRuns)
    .values({
      companyId: request.companyId,
      runType: "single",
      status: "running",
      scenarioType: request.scenarioType,
      parameters: {
        strategies: request.strategies.map((s) => s.name),
        simulatedDays: request.simulatedDays ?? 90,
      },
      totalUniverses: request.strategies.length,
      startedAt: new Date(),
    })
    .returning();

  eventBus.publish("simulation.started", {
    runId: run.id,
    companyId: request.companyId,
    scenarioType: request.scenarioType,
    strategyCount: request.strategies.length,
    timestamp: new Date().toISOString(),
  });

  try {
    // 3. Generate scenario configs
    const configs = request.strategies.map((strategy) =>
      buildScenarioConfig(request.scenarioType, strategy.name, strategy.variables, request.simulatedDays),
    );

    // 4. Execute all scenarios
    const results: ScenarioResult[] = [];
    for (let i = 0; i < configs.length; i++) {
      const result = runScenario(configs[i]);
      results.push(result);

      eventBus.publish("simulation.step.completed", {
        runId: run.id,
        strategyName: request.strategies[i].name,
        strategyIndex: i,
        totalStrategies: configs.length,
        profit: result.metrics.totalProfit,
        timestamp: new Date().toISOString(),
      });
    }

    // 5. Evaluate strategies
    const evaluation = evaluateStrategies(results);

    // 6. Check if the winner is deployable
    const winnerResult = results.find((r) => r.scenarioName === evaluation.winner.strategyName);
    const deployCheck = isStrategyDeployable(
      evaluation.winner.score,
      winnerResult?.metrics.failureRate ?? 1,
    );

    // 7. Persist results
    const executionTimeMs = Date.now() - start;

    await db
      .update(simulationRuns)
      .set({
        status: "completed",
        completedUniverses: results.length,
        resultScore: evaluation.winner.score,
        selectedStrategy: evaluation.winner.strategyName,
        summary: {
          rankings: evaluation.rankings,
          winner: evaluation.winner.strategyName,
          bestScore: evaluation.summary.bestScore,
          deployable: deployCheck.deployable,
        },
        completedAt: new Date(),
      })
      .where(eq(simulationRuns.id, run.id));

    eventBus.publish("simulation.finished", {
      runId: run.id,
      companyId: request.companyId,
      winner: evaluation.winner.strategyName,
      winnerScore: evaluation.winner.score,
      deployable: deployCheck.deployable,
      executionTimeMs,
      timestamp: new Date().toISOString(),
    });

    eventBus.publish("simulation.evaluated", {
      runId: run.id,
      companyId: request.companyId,
      totalStrategies: results.length,
      bestScore: evaluation.summary.bestScore,
      worstScore: evaluation.summary.worstScore,
      margin: evaluation.summary.marginOfVictory,
      timestamp: new Date().toISOString(),
    });

    if (deployCheck.deployable) {
      eventBus.publish("simulation.strategy.selected", {
        runId: run.id,
        companyId: request.companyId,
        strategyName: evaluation.winner.strategyName,
        score: evaluation.winner.score,
        timestamp: new Date().toISOString(),
      });
    }

    const winnerMetrics = winnerResult?.metrics;
    if (winnerMetrics) {
      const traffic = Math.max(1, Math.round(Math.abs(winnerMetrics.customerGrowth) * 10));
      const conversions = Math.max(0, Math.round(traffic * winnerMetrics.goalSuccessRate));
      const estimatedActions = Math.max(1, Math.round(winnerMetrics.taskCompletion * 100));
      await recordSystemMetric(db, {
        companyId: request.companyId,
        sourceType: "simulation_run",
        sourceId: run.id,
        traffic,
        conversions,
        revenueCents: Math.max(0, Math.round(winnerMetrics.totalRevenue)),
        taskSuccessRate: winnerMetrics.taskCompletion,
        costPerActionCents: winnerMetrics.totalCost / estimatedActions,
        metadata: {
          scenarioType: request.scenarioType,
          selectedStrategy: evaluation.winner.strategyName,
          deployable: deployCheck.deployable,
          score: evaluation.winner.score,
        },
      });
    }

    const snapshot = await getRecentSystemMetricsSnapshot(db, request.companyId, 240);
    const decision = await runAutonomousDecisionCycle(db, {
      companyId: request.companyId,
      metrics: snapshot,
      source: "simulation_run",
    });

    return {
      runId: run.id,
      status: "completed",
      scenarioType: request.scenarioType,
      strategyResults: results,
      evaluation,
      selectedStrategy: evaluation.winner.strategyName,
      deployable: deployCheck.deployable,
      deployReason: deployCheck.reason,
      decision,
      executionTimeMs,
    };
  } catch (err) {
    // Mark run as failed
    await db
      .update(simulationRuns)
      .set({ status: "failed", completedAt: new Date() })
      .where(eq(simulationRuns.id, run.id));

    throw err;
  }
}

/**
 * List simulation runs for a company.
 */
export async function listSimulationRuns(
  db: Db,
  companyId: string,
  limit = 20,
) {
  return db
    .select()
    .from(simulationRuns)
    .where(eq(simulationRuns.companyId, companyId))
    .orderBy(sql`${simulationRuns.createdAt} desc`)
    .limit(limit);
}

/**
 * Get a specific simulation run.
 */
export async function getSimulationRun(db: Db, runId: string) {
  const rows = await db
    .select()
    .from(simulationRuns)
    .where(eq(simulationRuns.id, runId));
  return rows[0] ?? null;
}

/**
 * List saved scenario templates for a company.
 */
export async function listScenarios(db: Db, companyId: string) {
  return db
    .select()
    .from(simulationScenarios)
    .where(eq(simulationScenarios.companyId, companyId));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildScenarioConfig(
  type: ScenarioType,
  name: string,
  variables: Record<string, number | string>,
  simulatedDays?: number,
): ScenarioConfig {
  switch (type) {
    case "company_launch":
      return createCompanyLaunchScenario(name, {
        teamSize: Number(variables.teamSize ?? 5),
        budgetCents: Number(variables.budgetCents ?? 50000),
        pricing: String(variables.pricing ?? "mid"),
        marketDemand: Number(variables.marketDemand ?? 50),
        simulatedDays,
      });

    case "hiring":
      return createHiringScenario(
        "sim_company",
        name,
        Number(variables.currentAgents ?? 5),
        Number(variables.additionalHires ?? 3),
        { budgetCents: Number(variables.budgetCents ?? 80000), simulatedDays },
      );

    case "pricing":
      return createPricingScenario(name, (variables.priceTier as "low" | "mid" | "premium") ?? "mid", {
        teamSize: Number(variables.teamSize ?? 5),
        budgetCents: Number(variables.budgetCents ?? 50000),
        simulatedDays,
      });

    default:
      // Generic scenario for other types
      return createCompanyLaunchScenario(name, {
        teamSize: Number(variables.teamSize ?? 5),
        budgetCents: Number(variables.budgetCents ?? 50000),
        simulatedDays,
      });
  }
}
