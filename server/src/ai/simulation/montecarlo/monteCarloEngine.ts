// ---------------------------------------------------------------------------
// Monte Carlo Engine — Orchestrator for Parallel-Universe Simulation
// ---------------------------------------------------------------------------
// Ties together:
//   universeGenerator  — creates & executes N parallel universes per strategy
//   probabilityAnalyzer — computes statistical summaries
//   strategySelector    — picks the best risk-adjusted strategy
//
// Also handles:
//   - DB persistence (simulation_universes, strategy_outcomes)
//   - Event emission
//   - Stability gating
// ---------------------------------------------------------------------------

import type { Db } from "@paperclipai/db";
import { eq } from "@paperclipai/db";
import {
  simulationRuns,
  simulationUniverses,
  strategyOutcomes,
} from "@paperclipai/db";
import pino from "pino";
import { eventBus } from "../../../events/eventBus.js";
import { assessStability } from "../../stability/ecosystemStabilityController.js";
import { scoreMetrics } from "../simulationMetrics.js";
import type { ScenarioType } from "../scenarioRunner.js";
import {
  generateUniverses,
  executeAllUniverses,
  type UniverseResult,
} from "./universeGenerator.js";
import {
  type VariableDefinition,
  COMPANY_LAUNCH_VARIABLES,
  HIRING_VARIABLES,
  PRICING_VARIABLES,
} from "./scenarioVariations.js";
import { analyzeAllStrategies, type StrategyStatistics } from "./probabilityAnalyzer.js";
import { selectStrategy, type SelectionResult } from "./strategySelector.js";
import { recordSystemMetric, getRecentSystemMetricsSnapshot } from "../../feedback/metricsEngine.js";
import { runAutonomousDecisionCycle, type DecisionCycleResult } from "../../governance/decisionEngine.js";

const logger = pino({ name: "montecarlo-engine" });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MonteCarloRequest {
  companyId: string;
  scenarioType: ScenarioType;
  strategies: Array<{
    name: string;
    variables: Record<string, number | string>;
  }>;
  /** Number of universes per strategy (default: 100) */
  universeCount?: number;
  /** Simulated days per universe (default: 90) */
  simulatedDays?: number;
  /** Custom variable definitions — falls back to built-in defaults */
  variableDefinitions?: VariableDefinition[];
  requestedBy: string;
}

export interface MonteCarloResult {
  runId: string;
  status: "completed" | "failed";
  scenarioType: ScenarioType;
  totalUniverses: number;
  completedUniverses: number;
  strategyStats: StrategyStatistics[];
  selection: SelectionResult;
  decision?: DecisionCycleResult;
  executionTimeMs: number;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * Run a full Monte Carlo simulation — the highest-fidelity strategy test.
 *
 * Flow:
 *   1. Stability gate
 *   2. Create DB run record
 *   3. For each strategy, generate & execute N universes
 *   4. Statistically analyze results
 *   5. Select optimal strategy
 *   6. Persist universes + outcomes to DB
 *   7. Emit telemetry events
 */
export async function runMonteCarlo(
  db: Db,
  request: MonteCarloRequest,
): Promise<MonteCarloResult> {
  const start = Date.now();
  const universeCount = request.universeCount ?? 100;
  const simulatedDays = request.simulatedDays ?? 90;

  // 1. Stability gate
  const stability = await assessStability(db);
  if (stability.action === "emergency_stop") {
    throw new Error("Monte Carlo blocked: ecosystem in emergency state");
  }
  if (stability.action === "freeze") {
    throw new Error("Monte Carlo blocked: ecosystem frozen — no new simulations");
  }

  // 2. Create run record
  const [run] = await db
    .insert(simulationRuns)
    .values({
      companyId: request.companyId,
      runType: "monte_carlo",
      status: "running",
      scenarioType: request.scenarioType,
      parameters: {
        strategies: request.strategies.map((s) => s.name),
        universeCount,
        simulatedDays,
      },
      totalUniverses: request.strategies.length * universeCount,
      startedAt: new Date(),
    })
    .returning();

  eventBus.publish("simulation.montecarlo.started", {
    runId: run.id,
    companyId: request.companyId,
    scenarioType: request.scenarioType,
    strategies: request.strategies.map((s) => s.name),
    universesPerStrategy: universeCount,
    totalUniverses: request.strategies.length * universeCount,
    timestamp: new Date().toISOString(),
  });

  try {
    // 3. Resolve variable definitions
    const variables = request.variableDefinitions ?? getDefaultVariables(request.scenarioType);

    // 4. Execute universes for each strategy
    const allStrategyResults: Array<{
      strategyName: string;
      results: UniverseResult[];
    }> = [];

    let completedTotal = 0;

    for (const strategy of request.strategies) {
      const baseVariables = strategy.variables ?? {};
      const configs = generateUniverses(
        request.scenarioType,
        strategy.name,
        variables,
        universeCount,
        simulatedDays,
      ).map((cfg) => ({
        ...cfg,
        variables: {
          ...cfg.variables,
          ...baseVariables,
        },
      }));

      const results = executeAllUniverses(configs);
      allStrategyResults.push({ strategyName: strategy.name, results });

      completedTotal += results.length;

      // Persist universe results to DB
      for (const result of results) {
        await db.insert(simulationUniverses).values({
          runId: run.id,
          universeIndex: result.index,
          status: result.succeeded ? "completed" : "failed",
          variables: result.variables,
          metrics: {
            revenue: result.metrics.totalRevenue,
            cost: result.metrics.totalCost,
            profit: result.metrics.totalProfit,
            taskCompletion: result.metrics.taskCompletion,
            goalSuccessRate: result.metrics.goalSuccessRate,
            agentEfficiency: result.metrics.agentEfficiency,
            customerGrowth: result.metrics.customerGrowth,
            failureRate: result.metrics.failureRate,
          },
          simulatedDays: result.simulatedDays,
          resultScore: scoreMetrics(result.metrics).score,
          completedAt: new Date(),
        });
      }

      eventBus.publish("simulation.universe.completed", {
        runId: run.id,
        strategyName: strategy.name,
        completed: results.filter((r) => r.succeeded).length,
        failed: results.filter((r) => !r.succeeded).length,
        total: results.length,
        timestamp: new Date().toISOString(),
      });
    }

    // 5. Statistical analysis
    const strategyStats = analyzeAllStrategies(allStrategyResults);

    eventBus.publish("simulation.analysis.finished", {
      runId: run.id,
      companyId: request.companyId,
      strategiesAnalyzed: strategyStats.length,
      timestamp: new Date().toISOString(),
    });

    // 6. Persist strategy outcomes
    for (const stats of strategyStats) {
      await db.insert(strategyOutcomes).values({
        runId: run.id,
        strategyName: stats.strategyName,
        meanProfit: stats.profit.mean,
        medianProfit: stats.profit.median,
        variance: stats.profit.variance,
        standardDeviation: stats.profit.standardDeviation,
        successRate: stats.successProbability,
        failureRate: stats.failureRate.mean,
        meanRevenue: stats.revenue.mean,
        meanCost: stats.cost.mean,
        riskScore: stats.riskScore,
        confidenceLevel: stats.confidenceLevel,
        sampleSize: stats.validSamples,
        selected: "false",
        detailedStats: {
          profit: stats.profit,
          revenue: stats.revenue,
          cost: stats.cost,
          goalSuccessRate: stats.goalSuccessRate,
          agentEfficiency: stats.agentEfficiency,
          taskCompletion: stats.taskCompletion,
          failureRate: stats.failureRate,
        },
      });

      const traffic = Math.max(1, Math.round(stats.validSamples));
      const conversions = Math.max(0, Math.round(stats.successProbability * traffic));
      await recordSystemMetric(db, {
        companyId: request.companyId,
        sourceType: "strategy_outcome",
        sourceId: `${run.id}:${stats.strategyName}`,
        traffic,
        conversions,
        revenueCents: Math.max(0, Math.round(stats.revenue.mean * Math.max(1, stats.validSamples))),
        taskSuccessRate: stats.goalSuccessRate.mean,
        costPerActionCents: stats.cost.mean / traffic,
        metadata: {
          runId: run.id,
          strategy: stats.strategyName,
          confidence: stats.confidenceLevel,
          riskScore: stats.riskScore,
        },
      });
    }

    // 7. Select optimal strategy
    const selection = selectStrategy(strategyStats);

    // Mark the selected strategy
    if (selection.winner) {
      await db
        .update(strategyOutcomes)
        .set({ selected: "true" })
        .where(eq(strategyOutcomes.strategyName, selection.winner.strategyName));
    }

    // 8. Update run record
    const executionTimeMs = Date.now() - start;

    await db
      .update(simulationRuns)
      .set({
        status: "completed",
        completedUniverses: completedTotal,
        resultScore: selection.winner?.score ?? 0,
        selectedStrategy: selection.winner?.strategyName ?? null,
        summary: {
          viableStrategies: selection.viableCount,
          totalStrategies: strategyStats.length,
          winner: selection.winner?.strategyName ?? null,
          winnerScore: selection.winner?.score ?? 0,
          rankings: selection.rankings.map((r) => ({
            name: r.strategyName,
            score: r.score,
            recommended: r.recommended,
          })),
        },
        completedAt: new Date(),
      })
      .where(eq(simulationRuns.id, run.id));

    eventBus.publish("simulation.montecarlo.strategy.selected", {
      runId: run.id,
      companyId: request.companyId,
      winner: selection.winner?.strategyName ?? null,
      winnerScore: selection.winner?.score ?? 0,
      viableCount: selection.viableCount,
      totalStrategies: request.strategies.length,
      executionTimeMs,
      timestamp: new Date().toISOString(),
    });

    logger.info(
      {
        runId: run.id,
        totalUniverses: completedTotal,
        strategies: request.strategies.length,
        winner: selection.winner?.strategyName,
        executionTimeMs,
      },
      "Monte Carlo simulation completed",
    );

    const snapshot = await getRecentSystemMetricsSnapshot(db, request.companyId, 240);
    const decision = await runAutonomousDecisionCycle(db, {
      companyId: request.companyId,
      metrics: snapshot,
      source: "strategy_outcome",
    });

    return {
      runId: run.id,
      status: "completed",
      scenarioType: request.scenarioType,
      totalUniverses: request.strategies.length * universeCount,
      completedUniverses: completedTotal,
      strategyStats,
      selection,
      decision,
      executionTimeMs,
    };
  } catch (err) {
    await db
      .update(simulationRuns)
      .set({ status: "failed", completedAt: new Date() })
      .where(eq(simulationRuns.id, run.id));

    throw err;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getDefaultVariables(scenarioType: ScenarioType): VariableDefinition[] {
  switch (scenarioType) {
    case "company_launch":
      return COMPANY_LAUNCH_VARIABLES;
    case "hiring":
      return HIRING_VARIABLES;
    case "pricing":
      return PRICING_VARIABLES;
    default:
      return COMPANY_LAUNCH_VARIABLES;
  }
}
