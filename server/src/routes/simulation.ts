// ---------------------------------------------------------------------------
// Simulation Routes — Simulation & Monte Carlo API
// ---------------------------------------------------------------------------

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  runSimulation,
  listSimulationRuns,
  getSimulationRun,
  listScenarios,
} from "../ai/simulation/simulationEngine.js";
import {
  runMonteCarlo,
} from "../ai/simulation/montecarlo/monteCarloEngine.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { logActivity } from "../services/index.js";

type ScenarioTypeValue = "company_launch" | "hiring" | "pricing";
const ALLOWED_SCENARIO_TYPES = new Set<ScenarioTypeValue>(["company_launch", "hiring", "pricing"]);
type StrategyInput = {
  name: string;
  variables: Record<string, number | string>;
};

function toSafeVariables(raw: unknown): Record<string, number | string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, number | string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "number" || typeof value === "string") {
      out[key] = value;
    }
  }
  return out;
}

function normalizeStrategies(raw: unknown): { ok: true; value: StrategyInput[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: "strategies[] is required" };
  }

  const normalized: StrategyInput[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      const name = entry.trim();
      if (!name) return { ok: false, error: "strategy names must be non-empty strings" };
      normalized.push({ name, variables: {} });
      continue;
    }

    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, error: "each strategy must be a string or { name, variables } object" };
    }

    const obj = entry as Record<string, unknown>;
    const name = typeof obj.name === "string" ? obj.name.trim() : "";
    if (!name) return { ok: false, error: "each strategy object must include a non-empty name" };
    normalized.push({ name, variables: toSafeVariables(obj.variables) });
  }

  return { ok: true, value: normalized };
}

function parsePositiveInt(raw: unknown, field: string, opts?: { min?: number; max?: number }):
  | { ok: true; value: number | undefined }
  | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw)) {
    return { ok: false, error: `${field} must be an integer` };
  }
  if (opts?.min !== undefined && raw < opts.min) {
    return { ok: false, error: `${field} must be >= ${opts.min}` };
  }
  if (opts?.max !== undefined && raw > opts.max) {
    return { ok: false, error: `${field} must be <= ${opts.max}` };
  }
  return { ok: true, value: raw };
}

function isScenarioType(value: unknown): value is ScenarioTypeValue {
  return typeof value === "string" && ALLOWED_SCENARIO_TYPES.has(value as ScenarioTypeValue);
}

export function simulationRoutes(db: Db) {
  const r = Router();

  // =========================================================================
  // Simulation Runs (single strategy comparison)
  // =========================================================================

  /** Run a simulation comparing strategies */
  r.post(
    "/companies/:companyId/simulations",
    async (req, res, next) => {
      try {
        const { companyId } = req.params;
        assertCompanyAccess(req, companyId);
        const actor = getActorInfo(req);

        const { scenarioType, strategies, simulatedDays } = req.body;
        if (!isScenarioType(scenarioType)) {
          res.status(400).json({ error: "scenarioType must be one of: company_launch, hiring, pricing" });
          return;
        }

        const normalizedStrategies = normalizeStrategies(strategies);
        if (!normalizedStrategies.ok) {
          res.status(400).json({ error: normalizedStrategies.error });
          return;
        }

        const days = parsePositiveInt(simulatedDays, "simulatedDays", { min: 1, max: 3650 });
        if (!days.ok) {
          res.status(400).json({ error: days.error });
          return;
        }

        const result = await runSimulation(db, {
          companyId,
          scenarioType,
          strategies: normalizedStrategies.value,
          simulatedDays: days.value,
          requestedBy: actor.actorId,
        });

        await logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          action: "simulation.run.created",
          entityType: "simulation_run",
          entityId: result.runId,
          details: {
            scenarioType,
            strategiesCount: normalizedStrategies.value.length,
            selectedStrategy: result.selectedStrategy,
            deployable: result.deployable,
          },
        });

        res.status(201).json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  /** List simulation runs for a company */
  r.get(
    "/companies/:companyId/simulations",
    async (req, res, next) => {
      try {
        const { companyId } = req.params;
        assertCompanyAccess(req, companyId);
        const limit = req.query.limit ? Number(req.query.limit) : undefined;
        const runs = await listSimulationRuns(db, companyId, limit);
        res.json(runs);
      } catch (err) {
        next(err);
      }
    },
  );

  /** Get a specific simulation run */
  r.get(
    "/companies/:companyId/simulations/:runId",
    async (req, res, next) => {
      try {
        const { companyId, runId } = req.params;
        assertCompanyAccess(req, companyId);
        const run = await getSimulationRun(db, runId);
        if (!run) {
          res.status(404).json({ error: "Simulation run not found" });
          return;
        }
        res.json(run);
      } catch (err) {
        next(err);
      }
    },
  );

  // =========================================================================
  // Simulation Scenarios (templates)
  // =========================================================================

  /** List saved scenarios for a company */
  r.get(
    "/companies/:companyId/simulations/scenarios",
    async (req, res, next) => {
      try {
        const { companyId } = req.params;
        assertCompanyAccess(req, companyId);
        const scenarios = await listScenarios(db, companyId);
        res.json(scenarios);
      } catch (err) {
        next(err);
      }
    },
  );

  // =========================================================================
  // Monte Carlo Simulation
  // =========================================================================

  /** Run a Monte Carlo simulation */
  r.post(
    "/companies/:companyId/simulations/montecarlo",
    async (req, res, next) => {
      try {
        const { companyId } = req.params;
        assertCompanyAccess(req, companyId);
        const actor = getActorInfo(req);

        const {
          scenarioType,
          strategies,
          universeCount,
          simulatedDays,
          variableDefinitions,
        } = req.body;

        if (!isScenarioType(scenarioType)) {
          res.status(400).json({ error: "scenarioType must be one of: company_launch, hiring, pricing" });
          return;
        }

        const normalizedStrategies = normalizeStrategies(strategies);
        if (!normalizedStrategies.ok) {
          res.status(400).json({ error: normalizedStrategies.error });
          return;
        }

        const universes = parsePositiveInt(universeCount, "universeCount", { min: 1, max: 5000 });
        if (!universes.ok) {
          res.status(400).json({ error: universes.error });
          return;
        }

        const days = parsePositiveInt(simulatedDays, "simulatedDays", { min: 1, max: 3650 });
        if (!days.ok) {
          res.status(400).json({ error: days.error });
          return;
        }

        const result = await runMonteCarlo(db, {
          companyId,
          scenarioType,
          strategies: normalizedStrategies.value,
          universeCount: universes.value,
          simulatedDays: days.value,
          variableDefinitions,
          requestedBy: actor.actorId,
        });

        await logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          action: "simulation.montecarlo.created",
          entityType: "simulation_run",
          entityId: result.runId,
          details: {
            scenarioType,
            strategiesCount: normalizedStrategies.value.length,
            totalUniverses: result.totalUniverses,
            completedUniverses: result.completedUniverses,
            winner: result.selection.winner?.strategyName ?? null,
          },
        });

        res.status(201).json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  return r;
}
