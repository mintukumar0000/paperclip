import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { stabilityApi } from "../api/stability";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import {
  ShieldCheck,
  AlertTriangle,
  TrendingUp,
  TrendingDown,
  Pause,
  CheckCircle,
  XCircle,
  Activity,
  BarChart3,
  RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";

const stageColors: Record<string, string> = {
  formation: "text-blue-400",
  expansion: "text-green-400",
  hypergrowth: "text-yellow-400",
  instability: "text-orange-400",
  collapse: "text-red-400",
};

const actionColors: Record<string, string> = {
  allow: "text-green-400 bg-green-400/10",
  warn: "text-yellow-400 bg-yellow-400/10",
  throttle: "text-orange-400 bg-orange-400/10",
  freeze: "text-red-400 bg-red-400/10",
  emergency_stop: "text-red-500 bg-red-500/20",
};

const severityIcons: Record<string, typeof CheckCircle> = {
  info: CheckCircle,
  warning: AlertTriangle,
  critical: XCircle,
  emergency: XCircle,
};

export function Stability() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<"overview" | "events" | "thresholds">("overview");

  useEffect(() => {
    setBreadcrumbs([{ label: "Stability" }]);
  }, [setBreadcrumbs]);

  const { data: assessment, isLoading: loadingAssessment } = useQuery({
    queryKey: queryKeys.stability.assessment,
    queryFn: () => stabilityApi.assessment(),
  });

  const { data: events, isLoading: loadingEvents } = useQuery({
    queryKey: queryKeys.stability.events,
    queryFn: () => stabilityApi.events(50),
    enabled: tab === "events",
  });

  const { data: history } = useQuery({
    queryKey: queryKeys.stability.history,
    queryFn: () => stabilityApi.history(20),
    enabled: tab === "overview",
  });

  const { data: thresholds, isLoading: loadingThresholds } = useQuery({
    queryKey: queryKeys.stability.thresholds,
    queryFn: () => stabilityApi.thresholds(),
    enabled: tab === "thresholds",
  });

  const { data: canExpand } = useQuery({
    queryKey: queryKeys.stability.canExpand,
    queryFn: () => stabilityApi.canExpand(),
  });

  const resetMutation = useMutation({
    mutationFn: () => stabilityApi.resetThresholds(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.stability.thresholds });
    },
  });

  if (loadingAssessment) return <PageSkeleton variant="list" />;

  const score = assessment?.stabilityScore ?? 0;
  const scoreColor = score >= 70 ? "text-green-400" : score >= 40 ? "text-yellow-400" : "text-red-400";

  return (
    <div className="space-y-6">
      {/* Stability Score + Stage */}
      <div className="grid grid-cols-4 gap-4">
        <div className="rounded-lg border border-border bg-card p-4 text-center">
          <div className={cn("text-3xl font-bold", scoreColor)}>{score.toFixed(0)}</div>
          <div className="text-xs text-muted-foreground">Stability Score</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4 text-center">
          <div className={cn("text-lg font-semibold capitalize", stageColors[assessment?.stage ?? ""])}>
            {assessment?.stage ?? "—"}
          </div>
          <div className="text-xs text-muted-foreground">Ecosystem Stage</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4 text-center">
          <div className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium", actionColors[assessment?.action ?? "allow"])}>
            {assessment?.action === "allow" && <CheckCircle className="h-3 w-3" />}
            {assessment?.action === "warn" && <AlertTriangle className="h-3 w-3" />}
            {assessment?.action === "throttle" && <Pause className="h-3 w-3" />}
            {(assessment?.action === "freeze" || assessment?.action === "emergency_stop") && <XCircle className="h-3 w-3" />}
            {assessment?.action?.replace("_", " ") ?? "—"}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">Current Action</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4 text-center">
          <div className={cn("text-lg font-semibold", canExpand?.allowed ? "text-green-400" : "text-red-400")}>
            {canExpand?.allowed ? "Yes" : "No"}
          </div>
          <div className="text-xs text-muted-foreground">Expansion Allowed</div>
        </div>
      </div>

      {/* Indicators Grid */}
      {assessment?.indicators && (
        <div className="grid grid-cols-3 gap-3">
          {[
            { label: "Companies", value: assessment.indicators.companyCount, icon: TrendingUp },
            { label: "Agents", value: assessment.indicators.agentCount, icon: Activity },
            { label: "Active Goals", value: assessment.indicators.activeGoals, icon: BarChart3 },
            { label: "Task Backlog", value: assessment.indicators.taskBacklog, icon: TrendingDown },
            { label: "Agent Utilization", value: `${(assessment.indicators.agentUtilization * 100).toFixed(0)}%`, icon: Activity },
            { label: "Goal Growth Rate", value: `${(assessment.indicators.goalGrowthRate * 100).toFixed(1)}%`, icon: TrendingUp },
          ].map((item) => (
            <div key={item.label} className="flex items-center gap-3 rounded-lg border border-border bg-card p-3">
              <item.icon className="h-4 w-4 text-muted-foreground" />
              <div>
                <div className="text-sm font-medium text-foreground">{item.value}</div>
                <div className="text-xs text-muted-foreground">{item.label}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border">
        {(["overview", "events", "thresholds"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "px-3 py-1.5 text-xs font-medium capitalize transition-colors",
              tab === t ? "border-b-2 border-primary text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {tab === "overview" && (
        <div className="space-y-4">
          <h3 className="text-sm font-medium text-foreground">Stability History</h3>
          {history && history.length > 0 ? (
            <div className="overflow-auto rounded-lg border border-border">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border bg-muted/30">
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">Time</th>
                    <th className="px-3 py-2 text-right font-medium text-muted-foreground">Score</th>
                    <th className="px-3 py-2 text-right font-medium text-muted-foreground">Companies</th>
                    <th className="px-3 py-2 text-right font-medium text-muted-foreground">Agents</th>
                    <th className="px-3 py-2 text-right font-medium text-muted-foreground">Goals</th>
                    <th className="px-3 py-2 text-right font-medium text-muted-foreground">Backlog</th>
                    <th className="px-3 py-2 text-right font-medium text-muted-foreground">Pressure</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((m) => (
                    <tr key={m.id} className="border-b border-border last:border-0">
                      <td className="px-3 py-1.5 text-muted-foreground">{new Date(m.snapshotAt).toLocaleString()}</td>
                      <td className={cn("px-3 py-1.5 text-right font-medium", m.stabilityScore >= 70 ? "text-green-400" : m.stabilityScore >= 40 ? "text-yellow-400" : "text-red-400")}>
                        {m.stabilityScore.toFixed(0)}
                      </td>
                      <td className="px-3 py-1.5 text-right">{m.companyCount}</td>
                      <td className="px-3 py-1.5 text-right">{m.agentCount}</td>
                      <td className="px-3 py-1.5 text-right">{m.goalCount}</td>
                      <td className="px-3 py-1.5 text-right">{m.taskBacklog}</td>
                      <td className="px-3 py-1.5 text-right">{m.expansionPressure.toFixed(0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState icon={BarChart3} message="No stability snapshots recorded yet." />
          )}

          {assessment?.reasons && assessment.reasons.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-medium text-foreground">Active Warnings</h3>
              <div className="space-y-1">
                {assessment.reasons.map((r, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs text-yellow-400">
                    <AlertTriangle className="h-3 w-3 shrink-0" />
                    {r}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {tab === "events" && (
        <div className="space-y-3">
          {loadingEvents ? (
            <PageSkeleton variant="list" />
          ) : events && events.length > 0 ? (
            <div className="space-y-2">
              {events.map((ev) => {
                const Icon = severityIcons[ev.severity] ?? AlertTriangle;
                return (
                  <div
                    key={ev.id}
                    className="flex items-start gap-3 rounded-lg border border-border bg-card p-3"
                  >
                    <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", ev.severity === "emergency" || ev.severity === "critical" ? "text-red-400" : ev.severity === "warning" ? "text-yellow-400" : "text-muted-foreground")} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium capitalize text-foreground">{ev.eventType.replace("_", " ")}</span>
                        <span className="text-xs text-muted-foreground">·</span>
                        <span className="text-xs text-muted-foreground">{new Date(ev.createdAt).toLocaleString()}</span>
                      </div>
                      <div className="mt-0.5 text-xs text-muted-foreground">{ev.trigger}</div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        Action: <span className="font-medium text-foreground">{ev.action}</span> · Score: {ev.stabilityScore.toFixed(0)}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <EmptyState icon={ShieldCheck} message="No stability events recorded. System is stable." />
          )}
        </div>
      )}

      {tab === "thresholds" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-foreground">Stability Thresholds</h3>
            <button
              onClick={() => resetMutation.mutate()}
              className="flex items-center gap-1.5 rounded-md bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              <RefreshCw className="h-3 w-3" /> Reset to defaults
            </button>
          </div>
          {loadingThresholds ? (
            <PageSkeleton variant="list" />
          ) : thresholds ? (
            <div className="grid grid-cols-2 gap-3">
              {Object.entries(thresholds).map(([key, value]) => (
                <div key={key} className="flex items-center justify-between rounded-lg border border-border bg-card p-3">
                  <span className="text-xs text-muted-foreground">{key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase())}</span>
                  <span className="text-sm font-medium text-foreground">{typeof value === "number" ? value : String(value)}</span>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState icon={ShieldCheck} message="No thresholds configured." />
          )}
        </div>
      )}
    </div>
  );
}
