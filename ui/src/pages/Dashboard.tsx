import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CycleMode, TrafficChannel, TrafficMode } from "@paperclipai/shared";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { StatusBadge } from "../components/StatusBadge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Checkbox } from "../components/ui/checkbox";
import { Label } from "../components/ui/label";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { formatCents } from "../lib/utils";
import { systemControlsApi, type ExecutionFeedEventResponse, type SystemControlsResponse } from "../api/system-controls";
import { billingApi } from "../api/billing";
import { agentsApi } from "../api/agents";
import { issuesApi } from "../api/issues";
import { goalsApi } from "../api/goals";
import { approvalsApi } from "../api/approvals";
import {
  LayoutDashboard,
  Pause,
  Play,
  Rocket,
} from "lucide-react";

const CYCLE_MODES: Array<{ label: string; mode: CycleMode }> = [
  { label: "Run Cycle 1", mode: "launch" },
  { label: "Run Cycle 2", mode: "improve" },
  { label: "Run Cycle 3", mode: "scale" },
  { label: "Run Cycle 4", mode: "dominate" },
];

const CYCLE_VISUAL: CycleMode[] = ["launch", "improve", "scale", "dominate"];

const TRAFFIC_CHANNELS: TrafficChannel[] = ["reddit", "twitter", "hacker_news"];

const INTENSITY_MAP: Array<{ label: string; mode: TrafficMode }> = [
  { label: "Low", mode: "conservative" },
  { label: "Medium", mode: "balanced" },
  { label: "High", mode: "aggressive" },
];

function formatDateTime(value: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleTimeString();
}

function toTitleCase(value: string): string {
  return value
    .replace(/_/g, " ")
    .replace(/\./g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function inferSystemStatus(
  controls: SystemControlsResponse | undefined,
  hasRunningCycle: boolean,
): "running" | "paused" {
  if (!controls) return "paused";
  if (!controls.trafficEnabled) return "paused";
  if (hasRunningCycle) return "running";
  return "running";
}

function computeRpv(revenueCents: number, traffic: number): number {
  if (!Number.isFinite(revenueCents) || !Number.isFinite(traffic) || traffic <= 0) return 0;
  return revenueCents / traffic;
}

export function Dashboard() {
  const { selectedCompanyId, companies } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [intent, setIntent] = useState("Build a SaaS for cold email automation");
  const [feedBuffer, setFeedBuffer] = useState<ExecutionFeedEventResponse[]>([]);
  const [issueTitle, setIssueTitle] = useState("");
  const [goalTitle, setGoalTitle] = useState("");

  useEffect(() => {
    setBreadcrumbs([{ label: "Mission Control" }]);
  }, [setBreadcrumbs]);

  const controlsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.systemControls(selectedCompanyId) : ["system-controls", "none"],
    queryFn: () => systemControlsApi.getControls(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 10_000,
  });

  const cycleStateQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.cycleState(selectedCompanyId) : ["cycle-state", "none"],
    queryFn: () => systemControlsApi.getCycleState(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 5_000,
  });

  const decisionsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.systemDecisions(selectedCompanyId, 40) : ["system-decisions", "none"],
    queryFn: () => systemControlsApi.listDecisions(selectedCompanyId!, 40),
    enabled: !!selectedCompanyId,
    refetchInterval: 8_000,
  });

  const executionFeedQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.executionFeed(selectedCompanyId, "all", "all", 60) : ["execution-feed", "none"],
    queryFn: () => systemControlsApi.getExecutionFeed(selectedCompanyId!, { limit: 60 }),
    enabled: !!selectedCompanyId,
    refetchInterval: 8_000,
  });

  const revenueQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.billing.revenue(selectedCompanyId) : ["billing", "revenue", "none"],
    queryFn: () => billingApi.revenueSnapshot(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 20_000,
  });

  const financeQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.billing.finance(selectedCompanyId) : ["billing", "finance", "none"],
    queryFn: () => billingApi.financeSnapshot(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 20_000,
  });

  const agentsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.agents.list(selectedCompanyId) : ["agents", "none"],
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 20_000,
  });

  const issuesQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.issues.list(selectedCompanyId) : ["issues", "none"],
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 15_000,
  });

  const goalsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.goals.list(selectedCompanyId) : ["goals", "none"],
    queryFn: () => goalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 20_000,
  });

  const approvalsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.approvals.list(selectedCompanyId, "pending") : ["approvals", "none"],
    queryFn: () => approvalsApi.list(selectedCompanyId!, "pending"),
    enabled: !!selectedCompanyId,
    refetchInterval: 15_000,
  });

  useEffect(() => {
    if (!executionFeedQuery.data) return;
    setFeedBuffer(executionFeedQuery.data.slice(0, 40));
  }, [executionFeedQuery.data]);

  useEffect(() => {
    if (!selectedCompanyId) return;
    const stream = new EventSource(`/api/companies/${encodeURIComponent(selectedCompanyId)}/execution-feed/stream?limit=40`);

    const onSnapshot = (event: MessageEvent) => {
      try {
        const payload = JSON.parse(event.data) as ExecutionFeedEventResponse[];
        if (Array.isArray(payload)) {
          setFeedBuffer(payload.slice(0, 40));
        }
      } catch {
        // ignore parse failures
      }
    };

    const onUpdate = (event: MessageEvent) => {
      try {
        const payload = JSON.parse(event.data) as ExecutionFeedEventResponse;
        if (!payload || typeof payload.id !== "string") return;
        setFeedBuffer((current) => {
          if (current.some((entry) => entry.id === payload.id)) return current;
          return [payload, ...current].slice(0, 40);
        });
      } catch {
        // ignore parse failures
      }
    };

    stream.addEventListener("snapshot", onSnapshot);
    stream.addEventListener("update", onUpdate);
    return () => {
      stream.removeEventListener("snapshot", onSnapshot);
      stream.removeEventListener("update", onUpdate);
      stream.close();
    };
  }, [selectedCompanyId]);

  const refreshMissionData = () => {
    if (!selectedCompanyId) return;
    queryClient.invalidateQueries({ queryKey: queryKeys.systemControls(selectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.cycleState(selectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.executionFeed(selectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.systemDecisions(selectedCompanyId, 40) });
    queryClient.invalidateQueries({ queryKey: queryKeys.billing.revenue(selectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.billing.finance(selectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.goals.list(selectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(selectedCompanyId, "pending") });
  };

  const runCycleMutation = useMutation({
    mutationFn: (cycleType: CycleMode) =>
      systemControlsApi.runCycle(selectedCompanyId!, cycleType, "dashboard_manual_cycle_run"),
    onSuccess: refreshMissionData,
  });

  const runIntentMutation = useMutation({
    mutationFn: (startupIntent: string) =>
      systemControlsApi.runCycleFromIntent(selectedCompanyId!, startupIntent, "dashboard_startup_input"),
    onSuccess: () => {
      refreshMissionData();
      navigate("/command-center");
    },
  });

  const patchControlsMutation = useMutation({
    mutationFn: (patch: Partial<SystemControlsResponse>) =>
      systemControlsApi.updateControls(selectedCompanyId!, patch),
    onSuccess: refreshMissionData,
  });

  const approveDecisionMutation = useMutation({
    mutationFn: (decisionId: string) =>
      systemControlsApi.approveDecision(selectedCompanyId!, decisionId, "approved from dashboard"),
    onSuccess: refreshMissionData,
  });

  const rejectDecisionMutation = useMutation({
    mutationFn: (decisionId: string) =>
      systemControlsApi.rejectDecision(selectedCompanyId!, decisionId, "rejected from dashboard"),
    onSuccess: refreshMissionData,
  });

  const createIssueMutation = useMutation({
    mutationFn: (title: string) =>
      issuesApi.create(selectedCompanyId!, { title, status: "backlog", priority: "high" }),
    onSuccess: () => {
      setIssueTitle("");
      refreshMissionData();
    },
  });

  const assignIssueMutation = useMutation({
    mutationFn: ({ issueId, agentId }: { issueId: string; agentId: string | null }) =>
      issuesApi.update(issueId, { assigneeAgentId: agentId }),
    onSuccess: refreshMissionData,
  });

  const createGoalMutation = useMutation({
    mutationFn: (title: string) =>
      goalsApi.create(selectedCompanyId!, { title, status: "planned", level: "task" }),
    onSuccess: () => {
      setGoalTitle("");
      refreshMissionData();
    },
  });

  const pauseAgentMutation = useMutation({
    mutationFn: (agentId: string) => agentsApi.pause(agentId),
    onSuccess: refreshMissionData,
  });

  const resumeAgentMutation = useMutation({
    mutationFn: (agentId: string) => agentsApi.resume(agentId),
    onSuccess: refreshMissionData,
  });

  const restartAgentMutation = useMutation({
    mutationFn: (agentId: string) => agentsApi.invoke(agentId),
    onSuccess: refreshMissionData,
  });

  if (!selectedCompanyId) {
    if (companies.length === 0) {
      return (
        <EmptyState
          icon={LayoutDashboard}
          message="Create your first company to activate Mission Control."
        />
      );
    }
    return <EmptyState icon={LayoutDashboard} message="Select a company to open Mission Control." />;
  }

  const isLoading = controlsQuery.isLoading || cycleStateQuery.isLoading || executionFeedQuery.isLoading;
  if (isLoading) {
    return <PageSkeleton variant="dashboard" />;
  }

  const controls = controlsQuery.data;
  const cycleState = cycleStateQuery.data ?? [];
  const decisions = decisionsQuery.data ?? [];
  const agents = agentsQuery.data ?? [];
  const issues = issuesQuery.data ?? [];
  const goals = goalsQuery.data ?? [];
  const pendingApprovals = approvalsQuery.data ?? [];
  const revenue = financeQuery.data?.revenueCents ?? 0;
  const visitors = revenueQuery.data?.traffic ?? 0;
  const conversions = revenueQuery.data?.conversions ?? 0;
  const conversionRate = revenueQuery.data?.conversionRate ?? 0;
  const rpv = computeRpv(revenue, visitors);

  const activeRow = cycleState.find((row) => row.loopKey === "cycle_orchestrator")
    ?? cycleState.find((row) => row.status === "running")
    ?? null;
  const hasRunningCycle = cycleState.some((row) => row.status === "running");
  const latestEvent = feedBuffer[0] ?? null;
  const systemState = inferSystemStatus(controls, hasRunningCycle);
  const activeCycleMode: CycleMode = controls?.cycleMode ?? "launch";
  const activeCycleIndex = CYCLE_VISUAL.indexOf(activeCycleMode);

  const nextAction = useMemo(() => {
    if (!activeRow) return "Awaiting next autonomous action";
    if (activeRow.loopKey === "traffic") return "Analyze conversion and optimize targeting";
    if (activeRow.loopKey === "decision_engine") return "Review and execute queued decisions";
    if (activeRow.loopKey === "email_sequence") return "Advance monetization email sequence";
    if (activeRow.loopKey === "execution_loop") return "Dispatch work to the best agent";
    return "Continue cycle orchestration";
  }, [activeRow]);

  const systemBusy =
    runCycleMutation.isPending
    || runIntentMutation.isPending
    || patchControlsMutation.isPending
    || approveDecisionMutation.isPending
    || rejectDecisionMutation.isPending;

  return (
    <div className="space-y-5">
      <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">AutoRunner AI Mission Control</p>
            <h1 className="mt-1 text-2xl font-semibold text-foreground">Your AI Company Is {systemState === "running" ? "Running" : "Paused"}</h1>
            <div className="mt-3 flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
              <span>🟢 Status: {systemState.toUpperCase()}</span>
              <span>🚀 Cycle: {toTitleCase(activeCycleMode)}</span>
              <span>💰 Revenue: {formatCents(revenue)}</span>
              <span>📈 RPV: ${rpv.toFixed(1)}</span>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => runCycleMutation.mutate(activeCycleMode)} disabled={systemBusy}>
              <Play className="mr-1.5 h-4 w-4" />
              Run Cycle
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => patchControlsMutation.mutate({ trafficEnabled: false })}
              disabled={systemBusy || controls?.trafficEnabled === false}
            >
              <Pause className="mr-1.5 h-4 w-4" />
              Pause
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link to="/command-center">Control Center</Link>
            </Button>
          </div>
        </div>
      </section>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,1.35fr)]">
        <div className="space-y-4">
          <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <h2 className="text-sm font-semibold text-foreground">Startup Input</h2>
            <p className="mt-1 text-xs text-muted-foreground">Enter the company idea and launch the autonomous system.</p>
            <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
              <Input
                value={intent}
                onChange={(event) => setIntent(event.target.value)}
                placeholder="Build a SaaS for cold email automation"
              />
              <Button
                onClick={() => runIntentMutation.mutate(intent.trim())}
                disabled={runIntentMutation.isPending || intent.trim().length < 4}
              >
                <Rocket className="mr-1.5 h-4 w-4" />
                Launch Company
              </Button>
            </div>
          </section>

          <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <h2 className="text-sm font-semibold text-foreground">System Status</h2>
            <div className="mt-3 grid gap-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Current Cycle</span>
                <span className="font-medium text-foreground">{toTitleCase(activeCycleMode)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Status</span>
                <StatusBadge status={systemState} />
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Last Action</span>
                <span className="truncate text-right text-foreground">{latestEvent ? toTitleCase(latestEvent.action) : "No action yet"}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Next Action</span>
                <span className="truncate text-right text-foreground">{nextAction}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Last Event Time</span>
                <span className="text-foreground">{formatDateTime(latestEvent?.createdAt ?? null)}</span>
              </div>
            </div>
          </section>

          <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <h2 className="text-sm font-semibold text-foreground">Cycle Control</h2>
            <div className="mt-3 grid grid-cols-2 gap-2">
              {CYCLE_MODES.map((cycle) => (
                <Button
                  key={cycle.mode}
                  size="sm"
                  variant={cycle.mode === activeCycleMode ? "default" : "outline"}
                  onClick={() => runCycleMutation.mutate(cycle.mode)}
                  disabled={systemBusy}
                >
                  {cycle.label}
                </Button>
              ))}
            </div>
            <div className="mt-3 flex gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => patchControlsMutation.mutate({ trafficEnabled: false })}
                disabled={systemBusy || controls?.trafficEnabled === false}
              >
                Pause System
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => patchControlsMutation.mutate({ trafficEnabled: true })}
                disabled={systemBusy || controls?.trafficEnabled === true}
              >
                Resume System
              </Button>
            </div>
          </section>

          <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <h2 className="text-sm font-semibold text-foreground">Growth Control</h2>
            <div className="mt-3 space-y-3">
              <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                <span className="text-sm text-muted-foreground">Traffic</span>
                <Button
                  size="sm"
                  variant={controls?.trafficEnabled ? "default" : "outline"}
                  onClick={() => patchControlsMutation.mutate({ trafficEnabled: !controls?.trafficEnabled })}
                  disabled={systemBusy || !controls}
                >
                  {controls?.trafficEnabled ? "ON" : "OFF"}
                </Button>
              </div>

              <div className="space-y-2">
                <Label>Channels</Label>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  {TRAFFIC_CHANNELS.map((channel) => {
                    const enabled = controls?.trafficChannels?.includes(channel) ?? false;
                    return (
                      <label key={channel} className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
                        <Checkbox
                          checked={enabled}
                          onCheckedChange={(checked) => {
                            if (!controls) return;
                            const next = checked === true
                              ? Array.from(new Set([...(controls.trafficChannels ?? []), channel]))
                              : (controls.trafficChannels ?? []).filter((entry) => entry !== channel);
                            patchControlsMutation.mutate({ trafficChannels: next });
                          }}
                        />
                        <span>{toTitleCase(channel)}</span>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div className="space-y-2">
                <Label>Posting Intensity</Label>
                <div className="grid grid-cols-3 gap-2">
                  {INTENSITY_MAP.map((entry) => (
                    <Button
                      key={entry.mode}
                      size="sm"
                      variant={controls?.trafficMode === entry.mode ? "default" : "outline"}
                      onClick={() => patchControlsMutation.mutate({ trafficMode: entry.mode })}
                      disabled={systemBusy}
                    >
                      {entry.label}
                    </Button>
                  ))}
                </div>
              </div>
            </div>
          </section>

          <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <h2 className="text-sm font-semibold text-foreground">Conversion Panel</h2>
            <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
              <div className="rounded-md border border-border px-3 py-2">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Conversion Rate</p>
                <p className="mt-1 text-lg font-semibold text-foreground">{conversionRate.toFixed(2)}%</p>
              </div>
              <div className="rounded-md border border-border px-3 py-2">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Revenue</p>
                <p className="mt-1 text-lg font-semibold text-foreground">{formatCents(revenue)}</p>
              </div>
            </div>
            <div className="mt-3">
              <Label>Pricing</Label>
              <div className="mt-2 grid grid-cols-3 gap-2">
                {[
                  { label: "$9", variant: "entry_9" },
                  { label: "$19", variant: "entry_19" },
                  { label: "$29", variant: "entry_29" },
                ].map((option) => (
                  <Button
                    key={option.variant}
                    size="sm"
                    variant={controls?.pricingVariant === option.variant ? "default" : "outline"}
                    onClick={() => patchControlsMutation.mutate({ pricingVariant: option.variant })}
                    disabled={systemBusy}
                  >
                    {option.label}
                  </Button>
                ))}
              </div>
            </div>
            <Button
              className="mt-3"
              size="sm"
              variant="outline"
              onClick={() => runCycleMutation.mutate("dominate")}
              disabled={systemBusy}
            >
              Run A/B Test
            </Button>
          </section>
        </div>

        <div className="space-y-4">
          <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <h2 className="text-sm font-semibold text-foreground">Autonomous Cycles</h2>
            <div className="mt-3 grid grid-cols-4 gap-2">
              {CYCLE_VISUAL.map((mode, index) => (
                <div
                  key={mode}
                  className={`rounded-md border px-2 py-2 text-center text-xs ${
                    index === activeCycleIndex
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted-foreground"
                  }`}
                >
                  {toTitleCase(mode)}
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-foreground">Live Execution Feed</h2>
              <span className="text-xs text-muted-foreground">{feedBuffer.length} events</span>
            </div>
            <div className="mt-3 max-h-[18rem] space-y-2 overflow-auto">
              {feedBuffer.length === 0 ? (
                <div className="rounded-md border border-dashed border-border px-3 py-5 text-sm text-muted-foreground">
                  Your AI company is not running yet. Start the first cycle.
                </div>
              ) : (
                feedBuffer.slice(0, 20).map((event) => (
                  <div key={event.id} className="rounded-md border border-border px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="truncate text-sm text-foreground">{event.message || toTitleCase(event.action)}</div>
                      <StatusBadge status={event.status} />
                    </div>
                    <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
                      <span>{event.createdAt ? new Date(event.createdAt).toLocaleTimeString() : "-"}</span>
                      <span>{toTitleCase(event.category)}</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <h2 className="text-sm font-semibold text-foreground">Performance</h2>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <div className="rounded-md border border-border px-3 py-2">
                <p className="text-xs text-muted-foreground">Visitors</p>
                <p className="text-lg font-semibold text-foreground">{visitors}</p>
              </div>
              <div className="rounded-md border border-border px-3 py-2">
                <p className="text-xs text-muted-foreground">Conversions</p>
                <p className="text-lg font-semibold text-foreground">{conversions}</p>
              </div>
              <div className="rounded-md border border-border px-3 py-2">
                <p className="text-xs text-muted-foreground">Revenue</p>
                <p className="text-lg font-semibold text-foreground">{formatCents(revenue)}</p>
              </div>
              <div className="rounded-md border border-border px-3 py-2">
                <p className="text-xs text-muted-foreground">RPV</p>
                <p className="text-lg font-semibold text-foreground">${rpv.toFixed(1)}</p>
              </div>
            </div>
          </section>

          <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <h2 className="text-sm font-semibold text-foreground">Decision Engine</h2>
            <div className="mt-3 space-y-2">
              {decisions.length === 0 ? (
                <div className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                  No decisions yet.
                </div>
              ) : (
                decisions.slice(0, 6).map((decision) => {
                  const actionable = decision.status === "pending" || decision.status === "awaiting_approval";
                  return (
                    <div key={decision.id} className="rounded-md border border-border px-3 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-sm font-medium text-foreground">{toTitleCase(decision.actionKey)}</div>
                        <StatusBadge status={decision.status} />
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        Trigger: {decision.metricName ?? "n/a"}
                        {decision.metricValue == null ? "" : ` = ${decision.metricValue}`}
                        {decision.thresholdValue == null ? "" : ` (threshold ${decision.thresholdValue})`}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">Action: {toTitleCase(decision.actionType)}</div>
                      <div className="mt-1 text-xs text-muted-foreground">Why: {decision.reason}</div>
                      {actionable && (
                        <div className="mt-2 flex gap-2">
                          <Button
                            size="sm"
                            onClick={() => approveDecisionMutation.mutate(decision.id)}
                            disabled={approveDecisionMutation.isPending || rejectDecisionMutation.isPending}
                          >
                            Approve
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => rejectDecisionMutation.mutate(decision.id)}
                            disabled={approveDecisionMutation.isPending || rejectDecisionMutation.isPending}
                          >
                            Reject
                          </Button>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </section>

          <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <h2 className="text-sm font-semibold text-foreground">Control Plane</h2>

            <div className="mt-3 space-y-3">
              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Issues</p>
                <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                  <Input
                    value={issueTitle}
                    onChange={(event) => setIssueTitle(event.target.value)}
                    placeholder="Create issue: Improve onboarding flow"
                  />
                  <Button
                    size="sm"
                    onClick={() => createIssueMutation.mutate(issueTitle.trim())}
                    disabled={createIssueMutation.isPending || issueTitle.trim().length < 3}
                  >
                    Create
                  </Button>
                </div>
                <div className="mt-2 space-y-1">
                  {issues.slice(0, 4).map((issue) => (
                    <div key={issue.id} className="flex items-center justify-between gap-2 rounded-md border border-border px-2 py-1.5 text-xs">
                      <Link to={`/issues/${issue.identifier ?? issue.id}`} className="truncate text-foreground hover:underline">
                        {issue.title}
                      </Link>
                      <select
                        className="max-w-[9rem] rounded border border-border bg-background px-1 py-0.5 text-xs"
                        value={issue.assigneeAgentId ?? ""}
                        onChange={(event) => assignIssueMutation.mutate({
                          issueId: issue.id,
                          agentId: event.target.value || null,
                        })}
                      >
                        <option value="">Unassigned</option>
                        {agents.map((agent) => (
                          <option key={agent.id} value={agent.id}>{agent.name}</option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Agents</p>
                <div className="space-y-1">
                  {agents.slice(0, 4).map((agent) => (
                    <div key={agent.id} className="rounded-md border border-border px-2 py-1.5 text-xs">
                      <div className="flex items-center justify-between">
                        <span className="truncate text-foreground">{agent.name}</span>
                        <StatusBadge status={agent.status} />
                      </div>
                      <div className="mt-1 flex gap-1">
                        <Button size="sm" variant="outline" onClick={() => pauseAgentMutation.mutate(agent.id)}>Pause</Button>
                        <Button size="sm" variant="outline" onClick={() => resumeAgentMutation.mutate(agent.id)}>Resume</Button>
                        <Button size="sm" variant="outline" onClick={() => restartAgentMutation.mutate(agent.id)}>Restart</Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Goals</p>
                <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                  <Input
                    value={goalTitle}
                    onChange={(event) => setGoalTitle(event.target.value)}
                    placeholder="Create goal: Increase conversion to 5%"
                  />
                  <Button
                    size="sm"
                    onClick={() => createGoalMutation.mutate(goalTitle.trim())}
                    disabled={createGoalMutation.isPending || goalTitle.trim().length < 3}
                  >
                    Add Goal
                  </Button>
                </div>
                <div className="mt-2 space-y-1">
                  {goals.slice(0, 4).map((goal) => (
                    <div key={goal.id} className="flex items-center justify-between rounded-md border border-border px-2 py-1.5 text-xs">
                      <span className="truncate text-foreground">{goal.title}</span>
                      <StatusBadge status={goal.status} />
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Approvals</p>
                <div className="rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">
                  Pending approvals: <span className="font-medium text-foreground">{pendingApprovals.length}</span>
                </div>
              </div>

              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Overrides</p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => patchControlsMutation.mutate({ trafficEnabled: false })}
                  >
                    Stop Traffic
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => runCycleMutation.mutate("improve")}
                  >
                    Force Cycle 2
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      const restartCandidate = agents.find((agent) => agent.status === "running") ?? agents[0];
                      if (restartCandidate) restartAgentMutation.mutate(restartCandidate.id);
                    }}
                    disabled={agents.length === 0}
                  >
                    Restart Agent
                  </Button>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
