import { useEffect, useState } from "react";
import { Link, useNavigate } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CycleMode, TrafficChannel, TrafficMode } from "@paperclipai/shared";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { StatusBadge } from "../components/StatusBadge";
import { ExecutionStatusBadge } from "../components/ExecutionStatusBadge";
import { OutputEvidencePanel } from "../components/OutputEvidencePanel";
import { SystemTimeline } from "../components/SystemTimeline";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Checkbox } from "../components/ui/checkbox";
import { Label } from "../components/ui/label";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { formatCents } from "../lib/utils";
import { systemControlsApi, type ExecutionFeedEventResponse, type SystemControlsResponse } from "../api/system-controls";
import {
  extractEvidence,
  formatRelativeTime,
  getEventReason,
  getTraceLink,
  groupExecutionFeed,
  summarizeFeedSpam,
} from "../lib/execution-feed";
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

function safeText(value: unknown, fallback = "-"): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function toTitleCase(value: unknown): string {
  const text = safeText(value, "-");
  return text
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
  const revenue = Number(financeQuery.data?.revenueCents ?? 0);
  const visitors = Number(revenueQuery.data?.traffic ?? 0);
  const conversions = Number(revenueQuery.data?.conversions ?? 0);
  const conversionRate = Number(revenueQuery.data?.conversionRate ?? 0);
  const safeRevenue = Number.isFinite(revenue) ? revenue : 0;
  const safeVisitors = Number.isFinite(visitors) ? visitors : 0;
  const safeConversions = Number.isFinite(conversions) ? conversions : 0;
  const safeConversionRate = Number.isFinite(conversionRate) ? conversionRate : 0;
  const rpv = computeRpv(safeRevenue, safeVisitors);

  const activeRow = cycleState.find((row) => row.loopKey === "cycle_orchestrator")
    ?? cycleState.find((row) => row.status === "running")
    ?? null;
  const hasRunningCycle = cycleState.some((row) => row.status === "running");
  const latestEvent = feedBuffer[0] ?? null;
  const systemState = inferSystemStatus(controls, hasRunningCycle);
  const activeCycleMode: CycleMode = controls?.cycleMode ?? "launch";
  const activeCycleIndex = CYCLE_VISUAL.indexOf(activeCycleMode);

  const nextAction = !activeRow
    ? "Awaiting next autonomous action"
    : activeRow.loopKey === "traffic"
      ? "Analyze conversion and optimize targeting"
      : activeRow.loopKey === "decision_engine"
        ? "Review and execute queued decisions"
        : activeRow.loopKey === "email_sequence"
          ? "Advance monetization email sequence"
          : activeRow.loopKey === "execution_loop"
            ? "Dispatch work to the best agent"
            : "Continue cycle orchestration";

  const counts = new Map<string, number>();
  for (const event of feedBuffer) {
    if (!(event.status === "blocked" || event.status === "pending" || event.status === "skipped")) {
      continue;
    }
    const reason = getEventReason(event) ?? "Rule gate active";
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  const blockedReasonSummary = Array.from(counts.entries())
    .map(([reason, count]) => ({ reason, count }))
    .slice(0, 4);

  const showPausedByRulesBanner = !hasRunningCycle && blockedReasonSummary.length > 0;
  const spamSummary = summarizeFeedSpam(feedBuffer);
  const groupedFeed = groupExecutionFeed(feedBuffer, 20);
  const latestTrace = latestEvent ? getTraceLink(latestEvent) : null;

  const latestOutputRows = (() => {
    const dedupe = new Set<string>();
    const rows: Array<{ event: ExecutionFeedEventResponse; url: string; label: string }> = [];
    for (const event of feedBuffer) {
      const evidence = extractEvidence(event);
      if (!evidence?.url) continue;
      const key = `${evidence.type}:${evidence.url}`;
      if (dedupe.has(key)) continue;
      dedupe.add(key);
      rows.push({ event, url: evidence.url, label: evidence.label });
      if (rows.length >= 3) break;
    }
    return rows;
  })();

  const systemExplanation = showPausedByRulesBanner
    ? "Execution is paused by governance gates. Approvals, duplicate prevention, or safety limits are currently holding autonomous actions."
    : latestEvent
      ? `Latest action was ${toTitleCase(latestEvent.action)} ${formatRelativeTime(latestEvent.createdAt)}. Next focus: ${nextAction}.`
      : "No autonomous actions captured yet. Start or resume a cycle to generate execution traces and outputs.";

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
              <span>💰 Revenue: {formatCents(safeRevenue)}</span>
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

      {showPausedByRulesBanner ? (
        <section className="rounded-xl border border-yellow-300/60 bg-yellow-50/60 p-4 text-yellow-900 shadow-sm dark:border-yellow-900/60 dark:bg-yellow-950/30 dark:text-yellow-100">
          <p className="text-sm font-semibold">System Paused by Rules</p>
          <p className="mt-1 text-xs opacity-90">System is not stuck. It is waiting on policy gates:</p>
          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            {blockedReasonSummary.map((entry) => (
              <span key={entry.reason} className="rounded-full border border-yellow-500/40 bg-yellow-100/80 px-2 py-0.5 dark:bg-yellow-900/40">
                {entry.reason} ({entry.count})
              </span>
            ))}
          </div>
        </section>
      ) : null}

      <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-foreground">System Explanation Mode</h2>
            <p className="mt-1 text-xs text-muted-foreground">Why the company is taking this action now, and what the operator should expect next.</p>
          </div>
          {latestEvent ? <ExecutionStatusBadge status={latestEvent.status} /> : null}
        </div>
        <p className="mt-3 text-sm text-foreground">{systemExplanation}</p>
        {latestTrace ? (
          <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
            <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5">trace: {latestTrace.traceId.slice(0, 16)}</span>
            {latestTrace.decisionId ? <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5">decision: {latestTrace.decisionId.slice(0, 8)}</span> : null}
            {latestTrace.issueId ? <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5">issue: {latestTrace.issueId.slice(0, 8)}</span> : null}
            {latestTrace.goalId ? <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5">goal: {latestTrace.goalId.slice(0, 8)}</span> : null}
            {latestTrace.agentId ? <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5">agent: {latestTrace.agentId.slice(0, 8)}</span> : null}
          </div>
        ) : null}
      </section>

      <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Forced Output Surfacing</h2>
            <p className="mt-1 text-xs text-muted-foreground">Latest published artifacts are pinned here so operators can always verify real-world output.</p>
          </div>
          <span className="text-xs text-muted-foreground">{latestOutputRows.length} surfaced</span>
        </div>

        <div className="mt-3 space-y-2">
          {latestOutputRows.length === 0 ? (
            <div className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
              No public output links yet. Run a cycle to surface external proof.
            </div>
          ) : (
            latestOutputRows.map((row) => (
              <a
                key={`${row.event.id}-${row.url}`}
                href={row.url}
                target="_blank"
                rel="noreferrer"
                className="block rounded-md border border-border px-3 py-2 hover:bg-accent/40"
              >
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">{row.label}</p>
                    <p className="truncate text-sm text-foreground">{row.url}</p>
                  </div>
                  <ExecutionStatusBadge status={row.event.status} />
                </div>
              </a>
            ))
          )}
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
                <p className="mt-1 text-lg font-semibold text-foreground">{safeConversionRate.toFixed(2)}%</p>
              </div>
              <div className="rounded-md border border-border px-3 py-2">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Revenue</p>
                <p className="mt-1 text-lg font-semibold text-foreground">{formatCents(safeRevenue)}</p>
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
              <span className="text-xs text-muted-foreground">{feedBuffer.length} raw · {groupedFeed.length} grouped</span>
            </div>
            {spamSummary.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-2 text-xs">
                {spamSummary.map((entry) => (
                  <span key={entry.status} className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-muted-foreground">
                    {entry.status.toUpperCase()} x{entry.count}
                  </span>
                ))}
              </div>
            ) : null}
            <div className="mt-3 max-h-[18rem] space-y-2 overflow-auto">
              {groupedFeed.length === 0 ? (
                <div className="rounded-md border border-dashed border-border px-3 py-5 text-sm text-muted-foreground">
                  Your AI company is not running yet. Start the first cycle.
                </div>
              ) : (
                groupedFeed.map((group) => (
                  <div key={group.event.id} className="rounded-md border border-border px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="truncate text-sm text-foreground">
                        {safeText(group.event.message, toTitleCase(group.event.action))}
                      </div>
                      <div className="flex items-center gap-1.5">
                        {group.count > 1 ? <span className="text-xs text-muted-foreground">x{group.count}</span> : null}
                        <ExecutionStatusBadge status={group.event.status} />
                      </div>
                    </div>
                    {(group.event.status === "blocked" || group.event.status === "pending" || group.event.status === "skipped" || group.event.status === "failed") && (
                      <div className="mt-1 text-xs text-muted-foreground">
                        Reason: {group.reason ?? "Rule gate active"}
                      </div>
                    )}
                    <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
                      <span>{group.event.createdAt ? new Date(group.event.createdAt).toLocaleTimeString() : "-"}</span>
                      <span>{toTitleCase(group.event.category)}</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>

          <OutputEvidencePanel companyId={selectedCompanyId} />

          <SystemTimeline companyId={selectedCompanyId} />

          <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <h2 className="text-sm font-semibold text-foreground">Performance</h2>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <div className="rounded-md border border-border px-3 py-2">
                <p className="text-xs text-muted-foreground">Visitors</p>
                <p className="text-lg font-semibold text-foreground">{safeVisitors}</p>
              </div>
              <div className="rounded-md border border-border px-3 py-2">
                <p className="text-xs text-muted-foreground">Conversions</p>
                <p className="text-lg font-semibold text-foreground">{safeConversions}</p>
              </div>
              <div className="rounded-md border border-border px-3 py-2">
                <p className="text-xs text-muted-foreground">Revenue</p>
                <p className="text-lg font-semibold text-foreground">{formatCents(safeRevenue)}</p>
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
                      <div className="mt-1 text-xs text-muted-foreground">Why: {safeText(decision.reason)}</div>
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
                        {safeText(issue.title)}
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
                          <option key={agent.id} value={agent.id}>{safeText(agent.name)}</option>
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
                        <span className="truncate text-foreground">{safeText(agent.name)}</span>
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
                      <span className="truncate text-foreground">{safeText(goal.title)}</span>
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
