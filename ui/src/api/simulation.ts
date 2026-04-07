import { api } from "./client";

export interface SimulationRun {
  id: string;
  companyId: string;
  runType: string;
  status: string;
  scenarioType: string;
  strategyName: string | null;
  parameters: Record<string, unknown>;
  totalUniverses: number;
  completedUniverses: number;
  resultScore: number | null;
  selectedStrategy: string | null;
  summary: Record<string, unknown> | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface SimulationResult {
  runId: string;
  status: string;
  scenarioType: string;
  selectedStrategy: string;
  deployable: boolean;
  deployReason?: string;
  executionTimeMs: number;
  evaluation: {
    winner: { strategyName: string; score: number };
    rankings: Array<{ strategyName: string; score: number }>;
    summary: { bestScore: number; worstScore: number; marginOfVictory: number };
  };
}

export interface MonteCarloResult {
  runId: string;
  status: string;
  scenarioType: string;
  totalUniverses: number;
  completedUniverses: number;
  strategyStats: Array<{
    strategyName: string;
    profit: { mean: number; median: number; standardDeviation: number; p5: number; p95: number };
    successProbability: number;
    riskScore: number;
    confidenceLevel: number;
    validSamples: number;
  }>;
  selection: {
    winner: { strategyName: string; score: number; recommended: boolean; reason: string } | null;
    rankings: Array<{ strategyName: string; score: number; recommended: boolean; reason: string }>;
    viableCount: number;
    summary: string;
  };
  executionTimeMs: number;
}

export interface SimulationScenario {
  id: string;
  companyId: string;
  name: string;
  scenarioType: string;
  description: string | null;
  simulatedDays: number;
  defaultUniverses: number;
  createdAt: string;
}

export const simulationApi = {
  // Simulation Runs
  run: (companyId: string, data: {
    scenarioType: string;
    strategies: Array<{ name: string; variables: Record<string, number | string> }>;
    simulatedDays?: number;
  }) => api.post<SimulationResult>(`/companies/${companyId}/simulations`, data),

  list: (companyId: string, limit?: number) =>
    api.get<SimulationRun[]>(`/companies/${companyId}/simulations${limit ? `?limit=${limit}` : ""}`),

  get: (companyId: string, runId: string) =>
    api.get<SimulationRun>(`/companies/${companyId}/simulations/${runId}`),

  scenarios: (companyId: string) =>
    api.get<SimulationScenario[]>(`/companies/${companyId}/simulations/scenarios`),

  // Monte Carlo
  monteCarlo: (companyId: string, data: {
    scenarioType: string;
    strategies: Array<{ name: string; variables: Record<string, number | string> }>;
    universeCount?: number;
    simulatedDays?: number;
  }) => api.post<MonteCarloResult>(`/companies/${companyId}/simulations/montecarlo`, data),
};
