import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { simulationApi, type SimulationRun, type SimulationResult, type MonteCarloResult } from "../api/simulation";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import {
  FlaskConical,
  Play,
  CheckCircle,
  XCircle,
  Clock,
  BarChart3,
  Layers,
  Trophy,
  AlertTriangle,
} from "lucide-react";
import { cn } from "@/lib/utils";

const scenarioOptions = [
  { value: "company_launch", label: "Company Launch" },
  { value: "hiring", label: "Hiring Decision" },
  { value: "pricing", label: "Pricing Strategy" },
] as const;

const statusIcon = (status: string) => {
  switch (status) {
    case "completed": return <CheckCircle className="h-3.5 w-3.5 text-green-500" />;
    case "failed": return <XCircle className="h-3.5 w-3.5 text-red-500" />;
    case "running": return <Play className="h-3.5 w-3.5 text-blue-500" />;
    default: return <Clock className="h-3.5 w-3.5 text-yellow-500" />;
  }
};

export function Simulation() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<"runs" | "montecarlo" | "new">("runs");
  const [mcResult, setMcResult] = useState<MonteCarloResult | null>(null);

  // New simulation form
  const [scenarioType, setScenarioType] = useState("company_launch");
  const [strategies, setStrategies] = useState("conservative,balanced,aggressive");
  const [universeCount, setUniverseCount] = useState(50);
  const [simulatedDays, setSimulatedDays] = useState(90);
  const [runMode, setRunMode] = useState<"single" | "montecarlo">("single");

  useEffect(() => {
    setBreadcrumbs([{ label: "Simulation" }]);
  }, [setBreadcrumbs]);

  const { data: runs, isLoading: loadingRuns } = useQuery({
    queryKey: queryKeys.simulation.runs(selectedCompanyId!),
    queryFn: () => simulationApi.list(selectedCompanyId!, 30),
    enabled: !!selectedCompanyId,
  });

  const runSimMutation = useMutation({
    mutationFn: async (): Promise<SimulationResult | MonteCarloResult> => {
      const strats = strategies.split(",").map((s) => s.trim()).filter(Boolean);
      if (runMode === "montecarlo") {
        return simulationApi.monteCarlo(selectedCompanyId!, {
          scenarioType,
          strategies: strats.map((name) => ({ name, variables: {} })),
          universeCount,
          simulatedDays,
        });
      }
      return simulationApi.run(selectedCompanyId!, {
        scenarioType,
        strategies: strats.map((name) => ({ name, variables: {} })),
        simulatedDays,
      });
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.simulation.runs(selectedCompanyId!) });
      if ("strategyStats" in result) {
        setMcResult(result as unknown as MonteCarloResult);
        setTab("montecarlo");
      } else {
        setTab("runs");
      }
    },
  });

  if (!selectedCompanyId) return <EmptyState icon={FlaskConical} message="Select a company to run simulations." />;
  if (loadingRuns) return <PageSkeleton variant="list" />;

  return (
    <div className="space-y-6">
      {/* Overview Cards */}
      <div className="grid grid-cols-4 gap-4">
        <div className="rounded-lg border border-border bg-card p-4 text-center">
          <div className="text-2xl font-bold text-foreground">{runs?.length ?? 0}</div>
          <div className="text-xs text-muted-foreground">Total Runs</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4 text-center">
          <div className="text-2xl font-bold text-green-400">
            {runs?.filter((r: SimulationRun) => r.status === "completed").length ?? 0}
          </div>
          <div className="text-xs text-muted-foreground">Completed</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4 text-center">
          <div className="text-2xl font-bold text-blue-400">
            {runs?.filter((r: SimulationRun) => r.runType === "monte_carlo").length ?? 0}
          </div>
          <div className="text-xs text-muted-foreground">Monte Carlo Runs</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4 text-center">
          <div className="text-2xl font-bold text-foreground">
            {runs?.reduce((sum: number, r: SimulationRun) => sum + (r.completedUniverses ?? 0), 0) ?? 0}
          </div>
          <div className="text-xs text-muted-foreground">Universes Simulated</div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border">
        {(["runs", "montecarlo", "new"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "px-3 py-1.5 text-xs font-medium capitalize transition-colors",
              tab === t ? "border-b-2 border-primary text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t === "montecarlo" ? "Monte Carlo Results" : t === "new" ? "New Simulation" : "Run History"}
          </button>
        ))}
      </div>

      {/* Run History */}
      {tab === "runs" && (
        <div className="space-y-3">
          {runs && runs.length > 0 ? (
            <div className="overflow-auto rounded-lg border border-border">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border bg-muted/30">
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">Status</th>
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">Type</th>
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">Scenario</th>
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">Selected Strategy</th>
                    <th className="px-3 py-2 text-right font-medium text-muted-foreground">Score</th>
                    <th className="px-3 py-2 text-right font-medium text-muted-foreground">Universes</th>
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run: SimulationRun) => (
                    <tr key={run.id} className="border-b border-border last:border-0">
                      <td className="px-3 py-1.5">
                        <div className="flex items-center gap-1.5">{statusIcon(run.status)} <span className="capitalize">{run.status}</span></div>
                      </td>
                      <td className="px-3 py-1.5">
                        <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-medium", run.runType === "monte_carlo" ? "bg-blue-400/10 text-blue-400" : "bg-muted text-foreground")}>
                          {run.runType === "monte_carlo" ? "Monte Carlo" : "Single"}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 capitalize">{run.scenarioType?.replace("_", " ")}</td>
                      <td className="px-3 py-1.5">
                        {run.selectedStrategy ? (
                          <span className="flex items-center gap-1 text-green-400"><Trophy className="h-3 w-3" />{run.selectedStrategy}</span>
                        ) : <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="px-3 py-1.5 text-right font-medium">{run.resultScore?.toFixed(1) ?? "—"}</td>
                      <td className="px-3 py-1.5 text-right">{run.completedUniverses}/{run.totalUniverses}</td>
                      <td className="px-3 py-1.5 text-muted-foreground">{new Date(run.createdAt).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState icon={FlaskConical} message="No simulation runs yet. Start one from the New Simulation tab." />
          )}
        </div>
      )}

      {/* Monte Carlo Results */}
      {tab === "montecarlo" && (
        <div className="space-y-4">
          {mcResult ? (
            <>
              {/* Selection Result */}
              <div className="rounded-lg border border-border bg-card p-4">
                <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <Layers className="h-4 w-4 text-blue-400" />
                  Monte Carlo Analysis — {mcResult.totalUniverses} universes, {mcResult.executionTimeMs}ms
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{mcResult.selection.summary}</p>
              </div>

              {/* Strategy Rankings */}
              <h3 className="text-sm font-medium text-foreground">Strategy Rankings</h3>
              <div className="space-y-2">
                {mcResult.selection.rankings.map((rank, i) => (
                  <div
                    key={rank.strategyName}
                    className={cn("flex items-center justify-between rounded-lg border p-3",
                      i === 0 && rank.recommended ? "border-green-500/30 bg-green-500/5" : "border-border bg-card")}
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-xs font-bold text-muted-foreground">#{i + 1}</span>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-foreground">{rank.strategyName}</span>
                          {rank.recommended && <CheckCircle className="h-3 w-3 text-green-400" />}
                          {!rank.recommended && <AlertTriangle className="h-3 w-3 text-yellow-400" />}
                        </div>
                        <div className="text-xs text-muted-foreground">{rank.reason}</div>
                      </div>
                    </div>
                    <div className={cn("text-lg font-bold", rank.score >= 60 ? "text-green-400" : rank.score >= 30 ? "text-yellow-400" : "text-red-400")}>
                      {rank.score.toFixed(1)}
                    </div>
                  </div>
                ))}
              </div>

              {/* Strategy Statistics */}
              <h3 className="text-sm font-medium text-foreground">Strategy Statistics</h3>
              <div className="overflow-auto rounded-lg border border-border">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border bg-muted/30">
                      <th className="px-3 py-2 text-left font-medium text-muted-foreground">Strategy</th>
                      <th className="px-3 py-2 text-right font-medium text-muted-foreground">Mean Profit</th>
                      <th className="px-3 py-2 text-right font-medium text-muted-foreground">Median Profit</th>
                      <th className="px-3 py-2 text-right font-medium text-muted-foreground">Std Dev</th>
                      <th className="px-3 py-2 text-right font-medium text-muted-foreground">Success %</th>
                      <th className="px-3 py-2 text-right font-medium text-muted-foreground">Risk</th>
                      <th className="px-3 py-2 text-right font-medium text-muted-foreground">Confidence</th>
                      <th className="px-3 py-2 text-right font-medium text-muted-foreground">Samples</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mcResult.strategyStats.map((stat) => (
                      <tr key={stat.strategyName} className="border-b border-border last:border-0">
                        <td className="px-3 py-1.5 font-medium">{stat.strategyName}</td>
                        <td className="px-3 py-1.5 text-right">${stat.profit.mean.toFixed(0)}</td>
                        <td className="px-3 py-1.5 text-right">${stat.profit.median.toFixed(0)}</td>
                        <td className="px-3 py-1.5 text-right">{stat.profit.standardDeviation.toFixed(0)}</td>
                        <td className={cn("px-3 py-1.5 text-right font-medium", stat.successProbability >= 0.7 ? "text-green-400" : stat.successProbability >= 0.4 ? "text-yellow-400" : "text-red-400")}>
                          {(stat.successProbability * 100).toFixed(0)}%
                        </td>
                        <td className={cn("px-3 py-1.5 text-right", stat.riskScore <= 30 ? "text-green-400" : stat.riskScore <= 60 ? "text-yellow-400" : "text-red-400")}>
                          {stat.riskScore.toFixed(0)}
                        </td>
                        <td className="px-3 py-1.5 text-right">{(stat.confidenceLevel * 100).toFixed(0)}%</td>
                        <td className="px-3 py-1.5 text-right">{stat.validSamples}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <EmptyState icon={Layers} message="Run a Monte Carlo simulation to see statistical analysis here." />
          )}
        </div>
      )}

      {/* New Simulation Form */}
      {tab === "new" && (
        <div className="mx-auto max-w-lg space-y-4 rounded-lg border border-border bg-card p-5">
          <h3 className="text-sm font-medium text-foreground">New Simulation</h3>

          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Mode</label>
              <div className="flex gap-2">
                {(["single", "montecarlo"] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setRunMode(m)}
                    className={cn(
                      "flex-1 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
                      runMode === m ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {m === "montecarlo" ? "Monte Carlo" : "Single Comparison"}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Scenario Type</label>
              <select
                value={scenarioType}
                onChange={(e) => setScenarioType(e.target.value)}
                className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-xs text-foreground"
              >
                {scenarioOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>

            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Strategies (comma-separated)</label>
              <input
                type="text"
                value={strategies}
                onChange={(e) => setStrategies(e.target.value)}
                className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-xs text-foreground"
                placeholder="conservative, balanced, aggressive"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">Simulated Days</label>
                <input
                  type="number"
                  value={simulatedDays}
                  onChange={(e) => setSimulatedDays(Number(e.target.value))}
                  className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-xs text-foreground"
                  min={1}
                  max={365}
                />
              </div>
              {runMode === "montecarlo" && (
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">Universes per Strategy</label>
                  <input
                    type="number"
                    value={universeCount}
                    onChange={(e) => setUniverseCount(Number(e.target.value))}
                    className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-xs text-foreground"
                    min={10}
                    max={1000}
                  />
                </div>
              )}
            </div>

            <button
              onClick={() => runSimMutation.mutate()}
              disabled={runSimMutation.isPending}
              className={cn(
                "flex w-full items-center justify-center gap-2 rounded-md px-4 py-2 text-xs font-medium transition-colors",
                runSimMutation.isPending
                  ? "bg-muted text-muted-foreground"
                  : "bg-primary text-primary-foreground hover:bg-primary/90",
              )}
            >
              {runSimMutation.isPending ? (
                <><Clock className="h-3.5 w-3.5 animate-spin" /> Running...</>
              ) : (
                <><Play className="h-3.5 w-3.5" /> {runMode === "montecarlo" ? "Run Monte Carlo Simulation" : "Run Simulation"}</>
              )}
            </button>

            {runSimMutation.isError && (
              <div className="flex items-center gap-2 rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-400">
                <XCircle className="h-3.5 w-3.5 shrink-0" />
                {runSimMutation.error instanceof Error ? runSimMutation.error.message : "Simulation failed"}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
