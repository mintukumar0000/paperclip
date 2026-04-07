import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ActivityEvent, Agent } from "@paperclipai/shared";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { timeAgo } from "../lib/timeAgo";
import { EmptyState } from "../components/EmptyState";
import { MetricCard } from "../components/MetricCard";
import { StatusBadge } from "../components/StatusBadge";
import { PageSkeleton } from "../components/PageSkeleton";
import {
  aiDashboardApi,
  type AIDashboardSummary,
  type GoalMemory,
} from "../api/ai-dashboard";
import { billingApi, type CreateCheckoutSessionResponse } from "../api/billing";
import { agentsApi } from "../api/agents";
import { issuesApi } from "../api/issues";
import { activityApi, type RunForIssue } from "../api/activity";
import { heartbeatsApi } from "../api/heartbeats";
import { healthApi } from "../api/health";
import { governanceApi } from "../api/governance";
import { trackPaymentCompleted, trackPaymentStarted } from "@/lib/analytics";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Activity,
  ArrowRight,
  Bot,
  Brain,
  CheckCircle2,
  Clock3,
  Cpu,
  DollarSign,
  Gauge,
  GitBranch,
  Loader2,
  Network,
  Play,
  Radio,
  RefreshCw,
  Sparkles,
  Target,
  Terminal,
  XCircle,
} from "lucide-react";

interface SSEEvent {
  id: number;
  type: string;
  timestamp: string;
  data: Record<string, unknown>;
}

interface GoalFormState {
  agentId: string;
  issueId: string;
  goal: string;
  maxSteps: string;
  maxIterations: string;
}

type GoalStep = GoalMemory["steps"][number];

interface GraphNodeLayout {
  id: string;
  step: GoalStep;
  x: number;
  y: number;
  width: number;
  height: number;
  level: number;
}

interface GraphEdgeLayout {
  from: string;
  to: string;
  path: string;
}

interface GoalPrediction {
  nextStep: string;
  etaLabel: string;
  riskLevel: "low" | "medium" | "high";
  reasons: string[];
}

const EVENT_COLORS: Record<string, string> = {
  "ai.goal.completed": "text-green-500",
  "ai.goal.failed": "text-red-500",
  "ai.goal.cancelled": "text-orange-500",
  "ai.goal.created": "text-cyan-500",
  "ai.step.started": "text-cyan-500",
  "ai.step.completed": "text-green-500",
  "ai.step.failed": "text-red-500",
  "company.loop.tick": "text-muted-foreground",
};

function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString();
}

function formatShort(value: string | null | undefined, size = 8): string {
  if (!value) return "-";
  return value.slice(0, size);
}

function jsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? null, null, 2);
  } catch {
    return String(value);
  }
}

function numeric(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function truncateText(value: string, max = 32): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}...`;
}

function normalizeRunTime(run: RunForIssue): number {
  if (!run.startedAt || !run.finishedAt) return 0;
  const start = new Date(run.startedAt).getTime();
  const end = new Date(run.finishedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return Math.round((end - start) / 1000);
}

function extractArtifactCandidates(value: unknown, prefix = "root", depth = 0): Array<{ key: string; value: string }> {
  if (depth > 4 || value == null) return [];
  if (typeof value === "string") {
    return /(artifact|file|path|url|screenshot|output)/i.test(prefix)
      ? [{ key: prefix, value }]
      : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => extractArtifactCandidates(entry, `${prefix}[${index}]`, depth + 1));
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.entries(record).flatMap(([key, entry]) =>
      extractArtifactCandidates(entry, `${prefix}.${key}`, depth + 1),
    );
  }

  return [];
}

function normalizeHttpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return trimmed;
  return `https://${trimmed}`;
}

function computeGraphLayout(steps: GoalStep[]): {
  nodes: GraphNodeLayout[];
  edges: GraphEdgeLayout[];
  width: number;
  height: number;
} {
  if (steps.length === 0) {
    return { nodes: [], edges: [], width: 400, height: 120 };
  }

  const stepById = new Map<string, GoalStep>();
  for (const step of steps) stepById.set(step.id, step);

  const depthMemo = new Map<string, number>();
  const visiting = new Set<string>();

  const getDepth = (id: string): number => {
    const memo = depthMemo.get(id);
    if (memo != null) return memo;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const step = stepById.get(id);
    let depth = 0;
    for (const depId of step?.dependsOn ?? []) {
      if (!stepById.has(depId)) continue;
      depth = Math.max(depth, getDepth(depId) + 1);
    }
    visiting.delete(id);
    depthMemo.set(id, depth);
    return depth;
  };

  for (const step of steps) getDepth(step.id);

  const levelMap = new Map<number, GoalStep[]>();
  for (const step of steps) {
    const level = depthMemo.get(step.id) ?? 0;
    const group = levelMap.get(level) ?? [];
    group.push(step);
    levelMap.set(level, group);
  }

  const sortedLevels = [...levelMap.keys()].sort((a, b) => a - b);
  for (const level of sortedLevels) {
    const group = levelMap.get(level) ?? [];
    group.sort((a, b) => a.name.localeCompare(b.name));
  }

  const nodeWidth = 210;
  const nodeHeight = 76;
  const margin = 24;
  const xGap = 250;
  const yGap = 102;

  const nodes: GraphNodeLayout[] = [];
  for (const level of sortedLevels) {
    const group = levelMap.get(level) ?? [];
    for (let row = 0; row < group.length; row += 1) {
      const step = group[row];
      nodes.push({
        id: step.id,
        step,
        width: nodeWidth,
        height: nodeHeight,
        x: margin + level * xGap,
        y: margin + row * yGap,
        level,
      });
    }
  }

  const nodeById = new Map<string, GraphNodeLayout>();
  for (const node of nodes) nodeById.set(node.id, node);

  const edges: GraphEdgeLayout[] = [];
  for (const node of nodes) {
    for (const depId of node.step.dependsOn ?? []) {
      const from = nodeById.get(depId);
      if (!from) continue;
      const startX = from.x + from.width;
      const startY = from.y + from.height / 2;
      const endX = node.x;
      const endY = node.y + node.height / 2;
      const bendX = startX + Math.max(24, (endX - startX) / 2);
      const path = `M ${startX} ${startY} C ${bendX} ${startY}, ${bendX} ${endY}, ${endX} ${endY}`;
      edges.push({ from: depId, to: node.id, path });
    }
  }

  const maxLevel = sortedLevels[sortedLevels.length - 1] ?? 0;
  const tallestColumn = Math.max(...[...levelMap.values()].map((group) => group.length), 1);
  const width = margin * 2 + (maxLevel + 1) * xGap;
  const height = margin * 2 + tallestColumn * yGap;

  return { nodes, edges, width, height };
}

function buildGoalPrediction(steps: GoalStep[], runs: RunForIssue[]): GoalPrediction {
  if (steps.length === 0) {
    return {
      nextStep: "No steps",
      etaLabel: "ETA unavailable",
      riskLevel: "low",
      reasons: ["Goal has no task graph yet."],
    };
  }

  const completed = new Set(
    steps
      .filter((step) => step.status === "completed")
      .map((step) => step.id),
  );

  const ready = steps.filter(
    (step) =>
      step.status === "pending" &&
      (step.dependsOn ?? []).every((depId) => completed.has(depId)),
  );
  const running = steps.filter((step) => step.status === "running");
  const blockedPending = steps.filter(
    (step) =>
      step.status === "pending" &&
      (step.dependsOn ?? []).some((depId) => !completed.has(depId)),
  );

  const nextStep = running[0]?.name ?? ready[0]?.name ?? blockedPending[0]?.name ?? "No next step";

  const durations = runs
    .map((run) => normalizeRunTime(run))
    .filter((value) => value > 0);
  const avgDurationSec =
    durations.length > 0
      ? durations.reduce((sum, value) => sum + value, 0) / durations.length
      : 90;

  const remainingCount = steps.filter(
    (step) => step.status === "pending" || step.status === "running",
  ).length;
  const etaSec = Math.max(30, Math.round(avgDurationSec * Math.max(1, remainingCount)));
  const etaLabel =
    etaSec < 60
      ? `${etaSec}s`
      : `${Math.max(1, Math.round(etaSec / 60))}m`;

  const nearRetryLimit = steps.filter((step) => {
    const retries = numeric(step.retries, 0);
    const maxRetries = Math.max(1, numeric(step.maxRetries, 1));
    return retries >= maxRetries - 1;
  }).length;
  const failedSteps = steps.filter((step) => step.status === "failed").length;

  let riskScore = failedSteps * 2 + nearRetryLimit * 2;
  if (blockedPending.length > 0 && ready.length === 0 && running.length === 0) {
    riskScore += 2;
  }

  const riskLevel: GoalPrediction["riskLevel"] =
    riskScore >= 6 ? "high" : riskScore >= 3 ? "medium" : "low";

  const reasons: string[] = [];
  if (failedSteps > 0) reasons.push(`${failedSteps} failed step${failedSteps === 1 ? "" : "s"}`);
  if (nearRetryLimit > 0) reasons.push(`${nearRetryLimit} step(s) near retry limit`);
  if (blockedPending.length > 0 && ready.length === 0 && running.length === 0) {
    reasons.push("waiting on dependencies");
  }
  if (reasons.length === 0) reasons.push("execution flow looks stable");

  return {
    nextStep,
    etaLabel,
    riskLevel,
    reasons,
  };
}

function summarizeActivity(event: ActivityEvent): {
  headline: string;
  detail: string;
  toneClass: string;
} {
  const action = event.action.toLowerCase();
  const details = asRecord(event.details);
  const reason =
    asNonEmptyString(details.reason) ??
    asNonEmptyString(details.error) ??
    asNonEmptyString(details.errorMessage) ??
    asNonEmptyString(details.message);
  const retries = numeric(details.retries ?? details.retryCount ?? details.retry_count, 0);
  const durationMs = numeric(details.durationMs ?? details.duration_ms ?? details.duration, 0);
  const durationLabel =
    durationMs > 0 ? `${Math.max(0.1, Math.round((durationMs / 100) / 10))}s` : null;

  if (action.includes("retry")) {
    return {
      headline: `${event.actorType}:${formatShort(event.actorId)} retrying`,
      detail: retries > 0 ? `Attempt ${retries} ${reason ? `due to ${reason}` : ""}` : reason ?? "Retry requested",
      toneClass: "text-amber-500",
    };
  }

  if (action.includes("failed") || action.includes("error") || action.includes("blocked")) {
    return {
      headline: `${event.actorType}:${formatShort(event.actorId)} blocked`,
      detail: reason ?? "Execution failed",
      toneClass: "text-red-500",
    };
  }

  if (action.includes("completed") || action.includes("done")) {
    return {
      headline: `${event.actorType}:${formatShort(event.actorId)} completed step`,
      detail: durationLabel ? `Completed in ${durationLabel}` : "Execution completed",
      toneClass: "text-green-500",
    };
  }

  if (action.includes("running") || action.includes("started") || action.includes("tick")) {
    return {
      headline: `${event.actorType}:${formatShort(event.actorId)} running`,
      detail: reason ?? "Execution in progress",
      toneClass: "text-cyan-500",
    };
  }

  return {
    headline: `${event.actorType}:${formatShort(event.actorId)} updated state`,
    detail: reason ?? `${event.entityType}:${formatShort(event.entityId)}`,
    toneClass: "text-foreground",
  };
}

function useAIEventStream(companyId: string | null, onEvent: (() => void) | null) {
  const [events, setEvents] = useState<SSEEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const idCounter = useRef(0);

  useEffect(() => {
    if (!companyId) return;

    const source = new EventSource(`/api/companies/${companyId}/ai/dashboard/events`);

    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);

    const pushEvent = (type: string, payload: Record<string, unknown>) => {
      const event: SSEEvent = {
        id: ++idCounter.current,
        type,
        timestamp:
          typeof payload.timestamp === "string"
            ? payload.timestamp
            : new Date().toISOString(),
        data: payload,
      };
      setEvents((prev) => [event, ...prev].slice(0, 250));
      onEvent?.();
    };

    source.onmessage = (message) => {
      try {
        const payload = JSON.parse(message.data) as Record<string, unknown>;
        if (payload.type === "connected") {
          setConnected(true);
          return;
        }
        pushEvent(String(payload.type ?? "unknown"), payload);
      } catch {
        // Ignore malformed payloads.
      }
    };

    const names = [
      "ai.execution.started",
      "ai.execution.completed",
      "ai.goal.created",
      "ai.goal.completed",
      "ai.goal.failed",
      "ai.goal.cancelled",
      "ai.step.started",
      "ai.step.completed",
      "ai.step.failed",
      "company.loop.tick",
      "company.loop.completed",
      "engine.resolved",
      "engine.unavailable",
    ];

    for (const name of names) {
      source.addEventListener(name, (message) => {
        try {
          const payload = JSON.parse((message as MessageEvent).data) as Record<string, unknown>;
          pushEvent(name, payload);
        } catch {
          // Ignore malformed payloads.
        }
      });
    }

    return () => {
      source.close();
      setConnected(false);
    };
  }, [companyId, onEvent]);

  return {
    events,
    connected,
    clearEvents: () => setEvents([]),
  };
}

function Section({
  title,
  icon: Icon,
  right,
  children,
  className,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-lg border border-border bg-card p-4", className)}>
      <header className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">{title}</h3>
        </div>
        {right}
      </header>
      {children}
    </section>
  );
}

export function AIDashboard() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  const [goalForm, setGoalForm] = useState<GoalFormState>({
    agentId: "",
    issueId: "",
    goal: "",
    maxSteps: "",
    maxIterations: "",
  });
  const [selectedGoalId, setSelectedGoalId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [feedFilter, setFeedFilter] = useState<string>("");
  const [systemFilter, setSystemFilter] = useState<string>("");
  const [decisionResult, setDecisionResult] = useState<Record<string, unknown> | null>(null);
  const [billingProvider, setBillingProvider] = useState<"stripe" | "dodo">("stripe");
  const [billingAmountUsd, setBillingAmountUsd] = useState("49");
  const [latestCheckout, setLatestCheckout] = useState<CreateCheckoutSessionResponse | null>(null);
  const [latestRevenuePing, setLatestRevenuePing] = useState<{ amountCents: number; at: string } | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "AI Dashboard" }]);
  }, [setBreadcrumbs]);

  const dashboardKey = selectedCompanyId ? queryKeys.aiDashboard(selectedCompanyId) : ["ai-dashboard", "none"];
  const systemMetricsKey = selectedCompanyId
    ? ["ai-dashboard", "system-metrics", selectedCompanyId]
    : ["ai-dashboard", "system-metrics", "none"];
  const feedbackActionsKey = selectedCompanyId
    ? ["ai-dashboard", "feedback-actions", selectedCompanyId]
    : ["ai-dashboard", "feedback-actions", "none"];
  const billingRevenueKey = selectedCompanyId
    ? queryKeys.billing.revenue(selectedCompanyId)
    : ["billing", "revenue", "none"];
  const billingFinanceKey = selectedCompanyId
    ? queryKeys.billing.finance(selectedCompanyId)
    : ["billing", "finance", "none"];

  const onStreamRefresh = useCallback(() => {
    if (!selectedCompanyId) return;
    queryClient.invalidateQueries({ queryKey: dashboardKey });
    queryClient.invalidateQueries({ queryKey: queryKeys.activity(selectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: systemMetricsKey });
    queryClient.invalidateQueries({ queryKey: feedbackActionsKey });
    queryClient.invalidateQueries({ queryKey: billingRevenueKey });
    queryClient.invalidateQueries({ queryKey: billingFinanceKey });
    if (selectedGoalId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.aiGoalMemory(selectedCompanyId, selectedGoalId) });
    }
  }, [
    dashboardKey,
    billingFinanceKey,
    feedbackActionsKey,
    billingRevenueKey,
    queryClient,
    selectedCompanyId,
    selectedGoalId,
    systemMetricsKey,
  ]);

  const { events, connected, clearEvents } = useAIEventStream(selectedCompanyId, selectedCompanyId ? onStreamRefresh : null);

  const summaryQuery = useQuery({
    queryKey: dashboardKey,
    queryFn: () => aiDashboardApi.summary(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 2_000,
  });

  const agentsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.agents.list(selectedCompanyId) : ["agents", "none"],
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 2_000,
  });

  const issuesQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.issues.list(selectedCompanyId) : ["issues", "none"],
    queryFn: () => issuesApi.list(selectedCompanyId!, { status: "in_progress" }),
    enabled: !!selectedCompanyId,
    refetchInterval: 2_000,
  });

  const activityQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.activity(selectedCompanyId) : ["activity", "none"],
    queryFn: () => activityApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 2_000,
  });

  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    refetchInterval: 2_000,
  });

  const systemMetricsQuery = useQuery({
    queryKey: systemMetricsKey,
    queryFn: () => aiDashboardApi.systemMetrics(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 2_000,
  });

  const billingRevenueQuery = useQuery({
    queryKey: billingRevenueKey,
    queryFn: () => billingApi.revenueSnapshot(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 2_000,
  });

  const billingFinanceQuery = useQuery({
    queryKey: billingFinanceKey,
    queryFn: () => billingApi.financeSnapshot(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 2_000,
  });

  const feedbackActionsQuery = useQuery({
    queryKey: feedbackActionsKey,
    queryFn: () => aiDashboardApi.feedbackActions(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 2_000,
  });

  const goalMemoryQuery = useQuery({
    queryKey: selectedCompanyId && selectedGoalId ? queryKeys.aiGoalMemory(selectedCompanyId, selectedGoalId) : ["goal-memory", "none"],
    queryFn: () => aiDashboardApi.goalMemory(selectedCompanyId!, selectedGoalId!),
    enabled: !!selectedCompanyId && !!selectedGoalId,
    refetchInterval: 2_000,
  });

  const selectedGoalIssueId = goalMemoryQuery.data?.issueId ?? null;

  const runsForIssueQuery = useQuery({
    queryKey: selectedGoalIssueId ? queryKeys.issues.runs(selectedGoalIssueId) : ["issues", "runs", "none"],
    queryFn: () => activityApi.runsForIssue(selectedGoalIssueId!),
    enabled: !!selectedGoalIssueId,
    refetchInterval: 2_000,
  });

  const attachmentsQuery = useQuery({
    queryKey: selectedGoalIssueId ? queryKeys.issues.attachments(selectedGoalIssueId) : ["issues", "attachments", "none"],
    queryFn: () => issuesApi.listAttachments(selectedGoalIssueId!),
    enabled: !!selectedGoalIssueId,
    refetchInterval: 2_000,
  });

  const decisionCards = useMemo(() => {
    const cards: Array<{ decision: string; reason: string; source: string }> = [];

    for (const action of (feedbackActionsQuery.data ?? []).slice(0, 12)) {
      const decision =
        (typeof action.actionType === "string" && action.actionType) ||
        (typeof action.action === "string" && action.action) ||
        "feedback_action";
      const reason =
        (typeof action.reason === "string" && action.reason) ||
        (typeof action.description === "string" && action.description) ||
        "No reason provided";
      cards.push({ decision, reason, source: "feedback" });
    }

    const decisionRecord = decisionResult as Record<string, unknown> | null;
    const cycleActions = Array.isArray(decisionRecord?.actions)
      ? (decisionRecord?.actions as Array<Record<string, unknown>>)
      : [];
    for (const action of cycleActions.slice(0, 8)) {
      const decision =
        (typeof action.actionType === "string" && action.actionType) ||
        (typeof action.decision === "string" && action.decision) ||
        "decision_cycle_action";
      const reason =
        (typeof action.reason === "string" && action.reason) ||
        (typeof action.explanation === "string" && action.explanation) ||
        "No reason provided";
      cards.push({ decision, reason, source: "decision-cycle" });
    }

    return cards.slice(0, 12);
  }, [feedbackActionsQuery.data, decisionResult]);

  const selectedRun = useMemo(() => {
    const runs = runsForIssueQuery.data ?? [];
    if (runs.length === 0) return null;
    if (!selectedRunId) return runs[0] ?? null;
    return runs.find((run) => run.runId === selectedRunId) ?? runs[0] ?? null;
  }, [runsForIssueQuery.data, selectedRunId]);

  const runLogQuery = useQuery({
    queryKey: selectedRun ? ["heartbeat-log", selectedRun.runId] : ["heartbeat-log", "none"],
    queryFn: () => heartbeatsApi.log(selectedRun!.runId, 0, 320_000),
    enabled: !!selectedRun,
    refetchInterval:
      selectedRun && (selectedRun.status === "running" || selectedRun.status === "queued")
        ? 2_000
        : false,
  });

  useEffect(() => {
    const active = summaryQuery.data?.activeGoals ?? [];
    const recent = summaryQuery.data?.recentGoals ?? [];
    const allGoals = [...active, ...recent];
    if (allGoals.length === 0) {
      setSelectedGoalId(null);
      return;
    }
    if (selectedGoalId && allGoals.some((goal) => goal.id === selectedGoalId)) return;
    setSelectedGoalId(allGoals[0]?.id ?? null);
  }, [summaryQuery.data, selectedGoalId]);

  useEffect(() => {
    const runs = runsForIssueQuery.data ?? [];
    if (runs.length === 0) {
      setSelectedRunId(null);
      return;
    }
    if (selectedRunId && runs.some((run) => run.runId === selectedRunId)) return;
    setSelectedRunId(runs[0]?.runId ?? null);
  }, [runsForIssueQuery.data, selectedRunId]);

  const createGoalMutation = useMutation({
    mutationFn: () =>
      aiDashboardApi.createGoal(selectedCompanyId!, {
        agentId: goalForm.agentId,
        issueId: goalForm.issueId,
        goal: goalForm.goal.trim(),
        ...(goalForm.maxSteps.trim().length > 0 ? { maxSteps: Number(goalForm.maxSteps) } : {}),
        ...(goalForm.maxIterations.trim().length > 0
          ? { maxIterations: Number(goalForm.maxIterations) }
          : {}),
      }),
    onSuccess: (result) => {
      setGoalForm((current) => ({ ...current, goal: "", maxSteps: "", maxIterations: "" }));
      setSelectedGoalId(result.planId);
      if (!selectedCompanyId) return;
      queryClient.invalidateQueries({ queryKey: dashboardKey });
      queryClient.invalidateQueries({ queryKey: queryKeys.activity(selectedCompanyId) });
    },
  });

  const cancelGoalMutation = useMutation({
    mutationFn: (goalId: string) => aiDashboardApi.cancelGoal(selectedCompanyId!, goalId),
    onSuccess: () => {
      if (!selectedCompanyId) return;
      queryClient.invalidateQueries({ queryKey: dashboardKey });
    },
  });

  const retryGoalMutation = useMutation({
    mutationFn: (goalId: string) => aiDashboardApi.retryGoal(selectedCompanyId!, goalId),
    onSuccess: () => {
      if (!selectedCompanyId) return;
      queryClient.invalidateQueries({ queryKey: dashboardKey });
      if (selectedGoalId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.aiGoalMemory(selectedCompanyId, selectedGoalId) });
      }
    },
  });

  const runDecisionCycleMutation = useMutation({
    mutationFn: () => aiDashboardApi.runDecisionCycle(selectedCompanyId!),
    onSuccess: (result) => {
      setDecisionResult(result);
      if (!selectedCompanyId) return;
      queryClient.invalidateQueries({ queryKey: systemMetricsKey });
      queryClient.invalidateQueries({ queryKey: feedbackActionsKey });
      queryClient.invalidateQueries({ queryKey: queryKeys.activity(selectedCompanyId) });
    },
  });

  const createCheckoutSessionMutation = useMutation({
    mutationFn: async () => {
      const amountCents = Math.max(100, Math.round((Number(billingAmountUsd) || 0) * 100));
      trackPaymentStarted(billingProvider, amountCents / 100);
      const origin = window.location.origin;
      return billingApi.createCheckoutSession(selectedCompanyId!, {
        provider: billingProvider,
        successUrl: `${origin}/ai-dashboard?checkout=success`,
        cancelUrl: `${origin}/ai-dashboard?checkout=cancel`,
        lineItems: [
          {
            name: "Paperclip Control Plane Upgrade",
            amountCents,
            quantity: 1,
            currency: "usd",
          },
        ],
      });
    },
    onSuccess: (result) => {
      setLatestCheckout(result);
    },
  });

  const reportPaymentSuccessMutation = useMutation({
    mutationFn: async () => {
      const amountCents = Math.max(100, Math.round((Number(billingAmountUsd) || 0) * 100));
      return billingApi.reportPaymentSuccess({
        companyId: selectedCompanyId!,
        provider: billingProvider,
        sessionId: latestCheckout?.sessionId,
        amountCents,
        currency: "usd",
        metadata: {
          source: "ai-dashboard-manual",
        },
      });
    },
    onSuccess: (result) => {
      trackPaymentCompleted(billingProvider, result.amountCents / 100);
      setLatestRevenuePing({ amountCents: result.amountCents, at: new Date().toISOString() });
      if (!selectedCompanyId) return;
      queryClient.invalidateQueries({ queryKey: systemMetricsKey });
      queryClient.invalidateQueries({ queryKey: billingRevenueKey });
      queryClient.invalidateQueries({ queryKey: billingFinanceKey });
      queryClient.invalidateQueries({ queryKey: feedbackActionsKey });
      queryClient.invalidateQueries({ queryKey: queryKeys.activity(selectedCompanyId) });
    },
  });

  const summary = summaryQuery.data;
  const goalUpdatedAt = (goal: AIDashboardSummary["activeGoals"][number] | AIDashboardSummary["recentGoals"][number]) => {
    if ("updatedAt" in goal && typeof goal.updatedAt === "string") return goal.updatedAt;
    return goal.createdAt;
  };
  const goalIsRunning = (goal: AIDashboardSummary["activeGoals"][number] | AIDashboardSummary["recentGoals"][number]) =>
    "isRunning" in goal && goal.isRunning === true;

  const allGoals = useMemo(() => {
    const active = summary?.activeGoals ?? [];
    const recent = summary?.recentGoals ?? [];
    return [...active, ...recent].sort(
      (a, b) => new Date(goalUpdatedAt(b)).getTime() - new Date(goalUpdatedAt(a)).getTime(),
    );
  }, [summary]);

  const selectedGoal = useMemo(() => {
    if (!selectedGoalId) return null;
    return allGoals.find((goal) => goal.id === selectedGoalId) ?? null;
  }, [allGoals, selectedGoalId]);

  const steps = goalMemoryQuery.data?.steps ?? [];
  const stepById = useMemo(() => {
    const map = new Map<string, (typeof steps)[number]>();
    for (const step of steps) map.set(step.id, step);
    return map;
  }, [steps]);

  const graphLayout = useMemo(() => computeGraphLayout(steps), [steps]);

  const progressSummary = useMemo(() => {
    const total = steps.length;
    const completed = steps.filter((step) => step.status === "completed").length;
    const running = steps.filter((step) => step.status === "running").length;
    const pending = steps.filter((step) => step.status === "pending").length;
    const failed = steps.filter((step) => step.status === "failed").length;
    const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
    return { total, completed, running, pending, failed, percent };
  }, [steps]);

  const goalPrediction = useMemo(
    () => buildGoalPrediction(steps, runsForIssueQuery.data ?? []),
    [steps, runsForIssueQuery.data],
  );

  const failuresFromActivityLast10m = useMemo(() => {
    const threshold = Date.now() - 10 * 60_000;
    return (activityQuery.data ?? []).filter((event) => {
      const created = new Date(event.createdAt).getTime();
      if (!Number.isFinite(created) || created < threshold) return false;
      const action = event.action.toLowerCase();
      return action.includes("failed") || action.includes("error") || action.includes("blocked");
    }).length;
  }, [activityQuery.data]);

  const systemSummary = useMemo(() => {
    const serverState = summary?.systemStatus;
    if (serverState) {
      return {
        loopState: serverState.loopState,
        queueState: serverState.queueState,
        queueDepth: serverState.queueDepth,
        workersActive: serverState.workersActive,
        failuresLast10m: serverState.failuresLast10m,
      };
    }

    const workersActive = (summary?.agentStates ?? []).filter(
      (agent) => agent.currentGoal && agent.status !== "paused",
    ).length;
    const queueDepth = (summary?.activeGoals ?? []).reduce(
      (sum, goal) => sum + goal.progress.pending + goal.progress.running,
      0,
    );
    const queueState = queueDepth === 0 ? "healthy" : queueDepth >= 12 ? "backlogged" : "normal";
    const loopState = (summary?.goalStats.active ?? 0) > 0
      ? failuresFromActivityLast10m > 0 ? "degraded" : "running"
      : "idle";

    return {
      loopState,
      queueState,
      queueDepth,
      workersActive,
      failuresLast10m: failuresFromActivityLast10m,
    };
  }, [failuresFromActivityLast10m, summary]);

  const artifactCandidates = useMemo(() => {
    if (!selectedRun?.resultJson) return [];
    const raw = extractArtifactCandidates(selectedRun.resultJson);
    const seen = new Set<string>();
    const unique: Array<{ key: string; value: string }> = [];
    for (const entry of raw) {
      const normalized = `${entry.key}:${entry.value}`;
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      unique.push(entry);
    }
    return unique;
  }, [selectedRun]);

  const deploymentVisibility = useMemo(() => {
    if (!selectedRun?.resultJson) {
      return null;
    }

    const root = asRecord(selectedRun.resultJson);
    const toolResult = asRecord(root.toolResult);
    const source = Object.keys(toolResult).length > 0 ? toolResult : root;

    const deploymentUrl =
      normalizeHttpUrl(source.deploymentUrl) ??
      normalizeHttpUrl(source.url) ??
      normalizeHttpUrl(asRecord(source.data).deploymentUrl) ??
      normalizeHttpUrl(asRecord(source.data).url);

    if (!deploymentUrl) {
      return null;
    }

    const statusValue =
      asNonEmptyString(source.status) ??
      asNonEmptyString(source.state) ??
      asNonEmptyString(asRecord(source.data).status) ??
      "unknown";

    const timestampValue =
      asNonEmptyString(source.timestamp) ??
      asNonEmptyString(asRecord(source.verification).checkedAt) ??
      (typeof source.createdAt === "number"
        ? new Date(source.createdAt).toISOString()
        : asNonEmptyString(source.createdAt)) ??
      selectedRun.createdAt;

    return {
      deploymentUrl,
      status: statusValue,
      timestamp: timestampValue,
    };
  }, [selectedRun]);

  const activityFeed = useMemo(() => {
    const rows = activityQuery.data ?? [];
    if (!feedFilter.trim()) return rows.slice(0, 120);
    const needle = feedFilter.trim().toLowerCase();
    return rows
      .filter((row) => {
        const haystack = [row.action, row.entityType, row.entityId, row.actorType, row.actorId]
          .join(" ")
          .toLowerCase();
        return haystack.includes(needle);
      })
      .slice(0, 120);
  }, [activityQuery.data, feedFilter]);

  const systemLog = useMemo(() => {
    const rows = activityQuery.data ?? [];
    const scoped = rows.filter((row) =>
      row.action.startsWith("governance.") ||
      row.action.startsWith("ai.") ||
      row.action.startsWith("heartbeat."),
    );
    if (!systemFilter.trim()) return scoped.slice(0, 100);
    const needle = systemFilter.trim().toLowerCase();
    return scoped
      .filter((row) => JSON.stringify(row).toLowerCase().includes(needle))
      .slice(0, 100);
  }, [activityQuery.data, systemFilter]);

  const agentNetwork = useMemo(() => {
    const agentRows = summary?.agentStates ?? [];
    const nameById = new Map<string, string>();
    for (const row of agentRows) {
      nameById.set(row.id, row.name);
    }
    for (const row of agentsQuery.data ?? []) {
      if (!nameById.has(row.id)) {
        nameById.set(row.id, row.name);
      }
    }

    const nodes = agentRows.map((row) => ({
      id: row.id,
      label: nameById.get(row.id) ?? `Agent ${formatShort(row.id)}`,
      status: row.status,
      activeGoals: row.currentGoal ? 1 : 0,
    }));

    const edgeCounts = new Map<string, { from: string; to: string; count: number; via: string }>();
    const goalsByIssue = new Map<string, Array<typeof allGoals[number]>>();

    for (const goal of allGoals) {
      if (!goal.issueId) continue;
      const group = goalsByIssue.get(goal.issueId) ?? [];
      group.push(goal);
      goalsByIssue.set(goal.issueId, group);
    }

    for (const [issueId, group] of goalsByIssue.entries()) {
      const ordered = [...group].sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      );
      for (let index = 1; index < ordered.length; index += 1) {
        const from = ordered[index - 1].agentId;
        const to = ordered[index].agentId;
        if (!from || !to || from === to) continue;
        const key = `${from}:${to}`;
        const current = edgeCounts.get(key) ?? { from, to, count: 0, via: issueId };
        current.count += 1;
        edgeCounts.set(key, current);
      }
    }

    const edges = [...edgeCounts.values()];
    if (edges.length === 0 && nodes.length > 1) {
      for (let index = 1; index < nodes.length; index += 1) {
        edges.push({
          from: nodes[index - 1].id,
          to: nodes[index].id,
          count: 1,
          via: "active_goal_chain",
        });
      }
    }

    return { nodes, edges };
  }, [agentsQuery.data, allGoals, summary?.agentStates]);

  const agentNetworkLayout = useMemo(() => {
    const width = 520;
    const height = 300;
    const cx = width / 2;
    const cy = height / 2;
    const radius = Math.min(width, height) / 2 - 56;

    const points = new Map<string, { x: number; y: number }>();
    agentNetwork.nodes.forEach((node, index) => {
      const angle = ((Math.PI * 2) / Math.max(1, agentNetwork.nodes.length)) * index - Math.PI / 2;
      points.set(node.id, {
        x: cx + Math.cos(angle) * radius,
        y: cy + Math.sin(angle) * radius,
      });
    });

    return { width, height, points };
  }, [agentNetwork.nodes]);

  const decisionHistory = useMemo(() => {
    const rows: Array<{ id: string; at: string; title: string; detail: string; tone: "neutral" | "warn" | "bad" | "good" }> = [];

    for (const event of activityQuery.data ?? []) {
      const action = event.action.toLowerCase();
      if (
        !action.includes("decision") &&
        !action.startsWith("governance.") &&
        action !== "metrics.recorded" &&
        action !== "billing.payment.succeeded"
      ) {
        continue;
      }

      rows.push({
        id: event.id,
        at: new Date(event.createdAt).toISOString(),
        title: event.action,
        detail: `${event.entityType}:${formatShort(event.entityId)} · actor ${formatShort(event.actorId)}`,
        tone:
          action.includes("failed") || action.includes("rejected")
            ? "bad"
            : action.includes("approved") || action.includes("succeeded")
              ? "good"
              : action.includes("pause") || action.includes("warn")
                ? "warn"
                : "neutral",
      });
    }

    const cycleActions = Array.isArray((decisionResult as Record<string, unknown> | null)?.actions)
      ? ((decisionResult as Record<string, unknown>).actions as Array<Record<string, unknown>>)
      : [];

    cycleActions.slice(0, 12).forEach((action, index) => {
      const title =
        asNonEmptyString(action.actionType) ??
        asNonEmptyString(action.decision) ??
        "decision_cycle_action";
      const detail =
        asNonEmptyString(action.reason) ??
        asNonEmptyString(action.explanation) ??
        "No rationale provided";
      rows.push({
        id: `cycle-${index}`,
        at: new Date().toISOString(),
        title,
        detail,
        tone: "neutral",
      });
    });

    return rows
      .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
      .slice(0, 24);
  }, [activityQuery.data, decisionResult]);

  const metricSignals = useMemo(() => {
    const snapshot = asRecord(systemMetricsQuery.data?.snapshot);
    const revenueCents = numeric(
      snapshot.revenue ?? snapshot.revenue_cents,
      billingFinanceQuery.data?.revenueCents ?? billingRevenueQuery.data?.revenueCents ?? 0,
    );

    return [
      {
        key: "conversion_rate",
        label: "Conversion Rate",
        valueLabel: `${numeric(snapshot.conversion_rate, numeric(snapshot.conversionRate, 0)).toFixed(2)}%`,
      },
      {
        key: "task_success_rate",
        label: "Task Success",
        valueLabel: `${(numeric(snapshot.task_success_rate, numeric(snapshot.taskSuccessRate, 0)) * 100).toFixed(1)}%`,
      },
      {
        key: "cost_per_action",
        label: "Cost / Action",
        valueLabel: `$${(numeric(snapshot.cost_per_action, numeric(snapshot.costPerAction, 0)) / 100).toFixed(2)}`,
      },
      {
        key: "revenue",
        label: "Revenue",
        valueLabel: `$${(revenueCents / 100).toFixed(2)}`,
      },
      {
        key: "bounce_rate",
        label: "Bounce Rate",
        valueLabel: `${numeric(snapshot.bounce_rate, numeric(snapshot.bounceRate, 0)).toFixed(1)}%`,
      },
    ];
  }, [
    billingFinanceQuery.data?.revenueCents,
    billingRevenueQuery.data?.revenueCents,
    systemMetricsQuery.data?.snapshot,
  ]);

  const causalityRows = useMemo(() => {
    const rows = activityQuery.data ?? [];
    const payments = rows
      .filter((event) => event.action === "billing.payment.succeeded")
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 8);

    const duplicateByTransaction = new Map<string, number>();
    const duplicateBySession = new Map<string, number>();
    for (const event of rows) {
      if (event.action !== "billing.webhook.duplicate_ignored") continue;
      duplicateByTransaction.set(event.entityId, (duplicateByTransaction.get(event.entityId) ?? 0) + 1);
      const sessionId = asNonEmptyString(asRecord(event.details).sessionId);
      if (sessionId) {
        duplicateBySession.set(sessionId, (duplicateBySession.get(sessionId) ?? 0) + 1);
      }
    }

    const dispatches = rows.filter((event) => event.action === "billing.decision.dispatch");
    const financeUpdates = rows.filter((event) => event.action === "billing.finance.credited");
    const actionEvents = rows
      .filter((event) => event.action === "ai.decision.action.executed")
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    return payments.map((payment) => {
      const paymentDetails = asRecord(payment.details);
      const sessionId = asNonEmptyString(paymentDetails.sessionId);
      const externalEventId = asNonEmptyString(paymentDetails.externalEventId);
      const amountCents = numeric(paymentDetails.amountCents, 0);
      const paymentAt = new Date(payment.createdAt).getTime();

      const dispatch = dispatches.find((event) => {
        const details = asRecord(event.details);
        const dispatchSession = asNonEmptyString(details.sessionId);
        const dispatchExternalEventId = asNonEmptyString(details.externalEventId);
        const eventAt = new Date(event.createdAt).getTime();
        const nearPayment = Number.isFinite(eventAt) && Number.isFinite(paymentAt)
          ? eventAt >= paymentAt && eventAt - paymentAt <= 10 * 60_000
          : false;
        return (
          (sessionId && dispatchSession === sessionId) ||
          (externalEventId && dispatchExternalEventId === externalEventId) ||
          nearPayment
        );
      });

      const dispatchDetails = asRecord(dispatch?.details);
      const dispatchResult = asRecord(dispatchDetails.decisionDispatch);
      const dispatchMode = asNonEmptyString(dispatchResult.mode) ?? "unknown";
      const dispatchJobId = asNonEmptyString(dispatchResult.jobId);
      const transactionKey = dispatch?.entityId;

      const financeUpdate = financeUpdates.find((event) => {
        const details = asRecord(event.details);
        const financeSession = asNonEmptyString(details.sessionId);
        const financeExternalEventId = asNonEmptyString(details.externalEventId);
        const eventAt = new Date(event.createdAt).getTime();
        const nearPayment = Number.isFinite(eventAt) && Number.isFinite(paymentAt)
          ? eventAt >= paymentAt && eventAt - paymentAt <= 10 * 60_000
          : false;
        return (
          (sessionId && financeSession === sessionId) ||
          (externalEventId && financeExternalEventId === externalEventId) ||
          nearPayment
        );
      });

      const financeDetails = asRecord(financeUpdate?.details);
      const creditsAfterCents = financeUpdate ? numeric(financeDetails.creditsCents, 0) : null;
      const revenueAfterCents = financeUpdate ? numeric(financeDetails.revenueCents, 0) : null;
      const spentAfterCents = financeUpdate ? numeric(financeDetails.spentCents, 0) : null;

      const decisionAction = actionEvents.find((event) => {
        const eventAt = new Date(event.createdAt).getTime();
        if (!Number.isFinite(eventAt) || !Number.isFinite(paymentAt)) return false;
        if (eventAt < paymentAt || eventAt - paymentAt > 15 * 60_000) return false;
        const details = asRecord(event.details);
        const source = asNonEmptyString(details.source);
        return source === "manual" || source == null;
      });

      const actionDetails = asRecord(decisionAction?.details);
      const issueId = asNonEmptyString(actionDetails.issueId);
      const issueIdentifier = asNonEmptyString(actionDetails.issueIdentifier);
      const issueStatus = asNonEmptyString(actionDetails.status);
      const actionType = asNonEmptyString(actionDetails.actionType) ?? "none";
      const actionReason = asNonEmptyString(actionDetails.reason) ?? "No reason provided";
      const actionSuccess = actionDetails.success === true;

      const duplicateCount = (transactionKey ? duplicateByTransaction.get(transactionKey) : undefined) ??
        (sessionId ? duplicateBySession.get(sessionId) : undefined) ??
        0;

      return {
        id: payment.id,
        happenedAt: payment.createdAt,
        metricLabel: "Revenue",
        metricValue: `+$${(amountCents / 100).toFixed(2)}`,
        provider: asNonEmptyString(paymentDetails.provider) ?? "unknown",
        sessionId,
        decision: actionType,
        action: actionReason,
        source: "billing-webhook",
        dispatchMode,
        dispatchJobId,
        creditsAfterCents,
        revenueAfterCents,
        spentAfterCents,
        issueLabel: issueIdentifier ?? (issueId ? formatShort(issueId, 12) : "none"),
        issueStatus: issueStatus ?? "-",
        actionSuccess,
        duplicateCount,
      };
    });
  }, [activityQuery.data]);

  const idempotencyRows = useMemo(() => {
    return (activityQuery.data ?? [])
      .filter((event) => event.action === "billing.webhook.duplicate_ignored")
      .slice(0, 12)
      .map((event) => {
        const details = asRecord(event.details);
        return {
          id: event.id,
          at: event.createdAt,
          provider: asNonEmptyString(details.provider) ?? "unknown",
          sessionId: asNonEmptyString(details.sessionId) ?? "-",
          amountCents: numeric(details.amountCents, 0),
          transactionKey: event.entityId,
        };
      });
  }, [activityQuery.data]);

  const canCreateGoal =
    goalForm.agentId.length > 0 && goalForm.issueId.length > 0 && goalForm.goal.trim().length > 0;

  if (!selectedCompanyId) {
    return <EmptyState icon={Activity} message="Select a company to view the AI operator dashboard." />;
  }

  if (summaryQuery.isLoading) {
    return <PageSkeleton variant="dashboard" />;
  }

  if (summaryQuery.error) {
    return <p className="py-8 text-center text-sm text-destructive">{summaryQuery.error.message}</p>;
  }

  if (!summary) return null;

  const runningRuns = (runsForIssueQuery.data ?? []).filter(
    (run) => run.status === "running" || run.status === "queued",
  ).length;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-2 xl:grid-cols-6">
        <MetricCard icon={Target} value={summary.goalStats.active} label="Active Goals" />
        <MetricCard icon={CheckCircle2} value={summary.goalStats.completed} label="Completed" />
        <MetricCard icon={XCircle} value={summary.goalStats.failed} label="Failed" />
        <MetricCard icon={Bot} value={summary.agentStates.length} label="Agents" />
        <MetricCard icon={Terminal} value={runningRuns} label="Live Runs" />
        <MetricCard
          icon={Cpu}
          value={summary.engineStatus.engines.filter((engine) => engine.enabled).length}
          label="Active Engines"
        />
      </div>

      <div className="grid gap-2 md:grid-cols-5">
        <div className="rounded-md border border-border bg-muted/20 p-3">
          <div className="text-xs text-muted-foreground">Loop</div>
          <div className="mt-1 flex items-center gap-2 text-sm font-medium">
            <Radio
              className={cn(
                "h-3.5 w-3.5",
                systemSummary.loopState === "running" && "text-green-500",
                systemSummary.loopState === "degraded" && "text-amber-500",
                systemSummary.loopState === "idle" && "text-muted-foreground",
              )}
            />
            {systemSummary.loopState}
          </div>
        </div>

        <div className="rounded-md border border-border bg-muted/20 p-3">
          <div className="text-xs text-muted-foreground">Queue</div>
          <div className="mt-1 text-sm font-medium">{systemSummary.queueState}</div>
          <div className="text-xs text-muted-foreground">depth {systemSummary.queueDepth}</div>
        </div>

        <div className="rounded-md border border-border bg-muted/20 p-3">
          <div className="text-xs text-muted-foreground">Workers</div>
          <div className="mt-1 text-sm font-medium">{systemSummary.workersActive} active</div>
          <div className="text-xs text-muted-foreground">agent executors</div>
        </div>

        <div className="rounded-md border border-border bg-muted/20 p-3">
          <div className="text-xs text-muted-foreground">Failures (10m)</div>
          <div className="mt-1 text-sm font-medium">{systemSummary.failuresLast10m}</div>
          <div className="text-xs text-muted-foreground">recent execution failures</div>
        </div>

        <div className="rounded-md border border-border bg-muted/20 p-3">
          <div className="text-xs text-muted-foreground">Decision Feed</div>
          <div className="mt-1 text-sm font-medium">{decisionCards.length} evidence items</div>
          <div className="text-xs text-muted-foreground">trust + reasoning visibility</div>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-12">
        <Section
          title="Command + Goal Control"
          icon={Sparkles}
          className="xl:col-span-5"
          right={
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span
                className={cn(
                  "h-2 w-2 rounded-full",
                  connected ? "bg-green-500 animate-pulse" : "bg-red-500",
                )}
              />
              {connected ? "Live stream connected" : "Stream disconnected"}
            </div>
          }
        >
          <div className="grid gap-2 md:grid-cols-2">
            <Select
              value={goalForm.agentId || "__none"}
              onValueChange={(value) =>
                setGoalForm((current) => ({ ...current, agentId: value === "__none" ? "" : value }))
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select agent" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none">Select agent</SelectItem>
                {(agentsQuery.data ?? []).map((agent: Agent) => (
                  <SelectItem key={agent.id} value={agent.id}>
                    {agent.name} · {agent.role}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={goalForm.issueId || "__none"}
              onValueChange={(value) =>
                setGoalForm((current) => ({ ...current, issueId: value === "__none" ? "" : value }))
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select issue" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none">Select issue</SelectItem>
                {(issuesQuery.data ?? []).map((issue) => (
                  <SelectItem key={issue.id} value={issue.id}>
                    {(issue.identifier ?? issue.id.slice(0, 8)) + " · " + issue.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Textarea
            value={goalForm.goal}
            onChange={(event) =>
              setGoalForm((current) => ({ ...current, goal: event.target.value }))
            }
            className="mt-2 min-h-24"
            placeholder="Enter operator command / goal. Example: Recover landing page conversion drop and ship corrective copy + analytics validation."
          />

          <div className="mt-2 grid gap-2 md:grid-cols-2">
            <Input
              value={goalForm.maxSteps}
              onChange={(event) =>
                setGoalForm((current) => ({ ...current, maxSteps: event.target.value }))
              }
              placeholder="Max steps (optional)"
            />
            <Input
              value={goalForm.maxIterations}
              onChange={(event) =>
                setGoalForm((current) => ({ ...current, maxIterations: event.target.value }))
              }
              placeholder="Max iterations (optional)"
            />
          </div>

          <div className="mt-3 flex items-center gap-2">
            <Button
              disabled={!canCreateGoal || createGoalMutation.isPending}
              onClick={() => createGoalMutation.mutate()}
            >
              {createGoalMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
              Start goal
            </Button>
            <Button
              variant="outline"
              disabled={runDecisionCycleMutation.isPending}
              onClick={() => runDecisionCycleMutation.mutate()}
            >
              {runDecisionCycleMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Gauge className="mr-2 h-4 w-4" />}
              Run decision cycle
            </Button>
            <Button variant="ghost" onClick={() => summaryQuery.refetch()}>
              <RefreshCw className="mr-2 h-4 w-4" />
              Refresh
            </Button>
          </div>

          {(createGoalMutation.error || runDecisionCycleMutation.error) && (
            <p className="mt-2 text-sm text-destructive">
              {(createGoalMutation.error as Error | null)?.message ??
                (runDecisionCycleMutation.error as Error | null)?.message}
            </p>
          )}

          <div className="mt-4 rounded-md border border-border">
            <div className="border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">
              Goal Queue
            </div>
            <div className="max-h-72 overflow-y-auto divide-y divide-border">
              {allGoals.length === 0 && (
                <div className="px-3 py-6 text-center text-sm text-muted-foreground">No goals yet.</div>
              )}
              {allGoals.map((goal) => (
                <button
                  key={goal.id}
                  className={cn(
                    "w-full px-3 py-2 text-left hover:bg-accent/30",
                    selectedGoalId === goal.id && "bg-accent/40",
                  )}
                  onClick={() => setSelectedGoalId(goal.id)}
                >
                  <div className="flex items-center gap-2">
                    {goalIsRunning(goal) ? <Radio className="h-3 w-3 animate-pulse text-cyan-500" /> : <span className="h-3 w-3" />}
                    <span className="truncate text-sm font-medium">{goal.goal}</span>
                    <StatusBadge status={goal.status} />
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                    <span>Agent {formatShort(goal.agentId)}</span>
                    <span>Iter {goal.iterationsUsed}</span>
                    <span>{timeAgo(goalUpdatedAt(goal))}</span>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {selectedGoal && (
            <div className="mt-3 flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={cancelGoalMutation.isPending}
                onClick={() => cancelGoalMutation.mutate(selectedGoal.id)}
              >
                <XCircle className="mr-2 h-4 w-4" />
                Cancel goal
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={retryGoalMutation.isPending}
                onClick={() => retryGoalMutation.mutate(selectedGoal.id)}
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                Retry goal
              </Button>
            </div>
          )}
        </Section>

        <Section title="Task Graph + Task Table" icon={Brain} className="xl:col-span-7">
          {!selectedGoalId && <p className="py-6 text-sm text-muted-foreground">Select a goal to inspect its task graph.</p>}

          {selectedGoalId && goalMemoryQuery.isLoading && (
            <p className="py-6 text-sm text-muted-foreground">Loading task graph...</p>
          )}

          {goalMemoryQuery.error && (
            <p className="py-2 text-sm text-destructive">{(goalMemoryQuery.error as Error).message}</p>
          )}

          {goalMemoryQuery.data && (
            <>
              <div className="rounded-md border border-border bg-muted/20 p-3">
                <div className="text-sm font-medium">{goalMemoryQuery.data.goal}</div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>Plan {formatShort(goalMemoryQuery.data.planId)}</span>
                  <span>Agent {formatShort(goalMemoryQuery.data.agentId)}</span>
                  <span>Status {goalMemoryQuery.data.status}</span>
                  <span>
                    Iterations {goalMemoryQuery.data.iterationsUsed}/{goalMemoryQuery.data.maxIterations}
                  </span>
                </div>
              </div>

              <div className="mt-3 grid gap-2 md:grid-cols-4">
                <div className="rounded-md border border-border bg-background p-3">
                  <div className="text-xs text-muted-foreground">Progress</div>
                  <div className="mt-1 text-sm font-semibold">{progressSummary.percent}%</div>
                  <div className="text-xs text-muted-foreground">
                    {progressSummary.completed}/{progressSummary.total} steps completed
                  </div>
                </div>

                <div className="rounded-md border border-border bg-background p-3">
                  <div className="text-xs text-muted-foreground">Next Step</div>
                  <div className="mt-1 text-sm font-semibold">{truncateText(goalPrediction.nextStep, 38)}</div>
                  <div className="text-xs text-muted-foreground">planner-selected executable step</div>
                </div>

                <div className="rounded-md border border-border bg-background p-3">
                  <div className="text-xs text-muted-foreground">ETA</div>
                  <div className="mt-1 flex items-center gap-2 text-sm font-semibold">
                    <Clock3 className="h-4 w-4 text-muted-foreground" />
                    {goalPrediction.etaLabel}
                  </div>
                  <div className="text-xs text-muted-foreground">estimated completion window</div>
                </div>

                <div className="rounded-md border border-border bg-background p-3">
                  <div className="text-xs text-muted-foreground">Risk</div>
                  <div
                    className={cn(
                      "mt-1 text-sm font-semibold capitalize",
                      goalPrediction.riskLevel === "high" && "text-red-500",
                      goalPrediction.riskLevel === "medium" && "text-amber-500",
                      goalPrediction.riskLevel === "low" && "text-green-600",
                    )}
                  >
                    {goalPrediction.riskLevel}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {goalPrediction.reasons.join(" · ")}
                  </div>
                </div>
              </div>

              <div className="mt-3 overflow-x-auto rounded-md border border-border bg-muted/10 p-2">
                <svg
                  width={Math.max(720, graphLayout.width)}
                  height={Math.max(180, graphLayout.height)}
                  role="img"
                  aria-label="Task dependency graph"
                >
                  <defs>
                    <marker id="goal-graph-arrow" markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto">
                      <path d="M 0 0 L 10 5 L 0 10 z" className="fill-muted-foreground" />
                    </marker>
                  </defs>

                  {graphLayout.edges.map((edge) => (
                    <path
                      key={`${edge.from}->${edge.to}`}
                      d={edge.path}
                      className="stroke-muted-foreground/60"
                      strokeWidth={1.5}
                      fill="none"
                      markerEnd="url(#goal-graph-arrow)"
                    />
                  ))}

                  {graphLayout.nodes.map((node) => (
                    <g key={node.id} transform={`translate(${node.x}, ${node.y})`}>
                      <rect
                        width={node.width}
                        height={node.height}
                        rx={8}
                        className={cn(
                          "stroke-border",
                          node.step.status === "completed" && "fill-green-500/10",
                          node.step.status === "running" && "fill-cyan-500/12",
                          node.step.status === "failed" && "fill-red-500/12",
                          node.step.status === "pending" && "fill-background",
                        )}
                      />
                      <text x={10} y={22} className="fill-foreground text-xs font-medium">
                        {truncateText(node.step.name, 28)}
                      </text>
                      <text x={10} y={40} className="fill-muted-foreground text-[11px]">
                        {`status: ${node.step.status}`}
                      </text>
                      <text x={10} y={56} className="fill-muted-foreground text-[11px]">
                        {`retry: ${numeric(node.step.retries, 0)}/${numeric(node.step.maxRetries, 0)}`}
                      </text>
                    </g>
                  ))}
                </svg>
              </div>

              <div className="mt-3 overflow-x-auto pb-2">
                <div className="flex min-w-max items-start gap-2">
                  {steps.map((step) => (
                    <div key={step.id} className="w-56 rounded-md border border-border bg-background p-2">
                      <div className="flex items-center justify-between gap-2">
                        <p className="truncate text-sm font-medium">{step.name}</p>
                        <StatusBadge status={step.status} />
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{step.description ?? "No description"}</p>
                      <div className="mt-2 text-xs text-muted-foreground">
                        retries {step.retries ?? 0}/{step.maxRetries ?? 0}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        deps {step.dependsOn?.length ?? 0}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="mt-3 overflow-x-auto rounded-md border border-border">
                <table className="min-w-full text-xs">
                  <thead className="bg-muted/30 text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">Step</th>
                      <th className="px-3 py-2 text-left font-medium">Status</th>
                      <th className="px-3 py-2 text-left font-medium">Depends On</th>
                      <th className="px-3 py-2 text-left font-medium">Attempts</th>
                      <th className="px-3 py-2 text-left font-medium">Tool</th>
                      <th className="px-3 py-2 text-left font-medium">Output / Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {steps.map((step) => {
                      const attempts = (step.retries ?? 0) + (step.status === "pending" ? 0 : 1);
                      const dependencyNames = (step.dependsOn ?? []).map((id) => stepById.get(id)?.name ?? id);
                      return (
                        <tr key={step.id} className="border-t border-border">
                          <td className="max-w-56 px-3 py-2 align-top font-medium">{step.name}</td>
                          <td className="px-3 py-2 align-top">
                            <StatusBadge status={step.status} />
                          </td>
                          <td className="max-w-56 px-3 py-2 align-top text-muted-foreground">
                            {dependencyNames.length > 0 ? dependencyNames.join(", ") : "-"}
                          </td>
                          <td className="px-3 py-2 align-top text-muted-foreground">
                            {attempts}/{step.maxRetries ?? 0}
                          </td>
                          <td className="max-w-56 px-3 py-2 align-top text-muted-foreground">
                            {step.toolName ?? "-"}
                          </td>
                          <td className="max-w-xl px-3 py-2 align-top">
                            {step.error ? (
                              <span className="text-red-500">{step.error}</span>
                            ) : step.output ? (
                              <span className="line-clamp-2 text-muted-foreground">{String(step.output)}</span>
                            ) : (
                              <span className="text-muted-foreground">-</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Section>
      </div>

      <div className="grid gap-4 xl:grid-cols-12">
        <Section
          title="Live Activity Feed"
          icon={Activity}
          className="xl:col-span-4"
          right={
            <Button variant="ghost" size="sm" onClick={clearEvents}>
              Clear
            </Button>
          }
        >
          <Input
            value={feedFilter}
            onChange={(event) => setFeedFilter(event.target.value)}
            placeholder="Filter by action/entity"
          />

          <div className="mt-3 max-h-96 space-y-1 overflow-y-auto rounded-md border border-border p-2 font-mono text-xs">
            {events.length > 0 && (
              <div className="mb-2 border-b border-border pb-2">
                {events.slice(0, 10).map((event) => (
                  <div key={event.id} className="flex items-start gap-2 py-0.5">
                    <span className="shrink-0 text-muted-foreground">{new Date(event.timestamp).toLocaleTimeString()}</span>
                    <span className={cn("truncate", EVENT_COLORS[event.type] ?? "text-foreground")}>{event.type}</span>
                  </div>
                ))}
              </div>
            )}

            {activityFeed.length === 0 && (
              <p className="py-6 text-center font-sans text-sm text-muted-foreground">No activity events.</p>
            )}

            {activityFeed.map((event) => (
              <div key={event.id} className="rounded-sm border border-border/60 p-2">
                {(() => {
                  const summary = summarizeActivity(event);
                  return (
                    <>
                      <div className="flex items-center justify-between gap-2">
                        <span className={cn("truncate", summary.toneClass)}>{summary.headline}</span>
                        <span className="shrink-0 text-muted-foreground">{timeAgo(event.createdAt)}</span>
                      </div>
                      <div className="mt-1 text-muted-foreground">{summary.detail}</div>
                    </>
                  );
                })()}
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-[11px] text-muted-foreground">{event.action}</span>
                </div>
                <div className="mt-1 text-muted-foreground">
                  {event.entityType}:{formatShort(event.entityId)} · {event.actorType}:{formatShort(event.actorId)}
                </div>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Output + Artifacts" icon={Terminal} className="xl:col-span-8">
          {!selectedGoalIssueId && (
            <p className="py-6 text-sm text-muted-foreground">
              Select a goal linked to an issue to inspect run outputs and artifacts.
            </p>
          )}

          {selectedGoalIssueId && (
            <>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">Issue {formatShort(selectedGoalIssueId)}</span>
                <Select
                  value={selectedRunId || "__none"}
                  onValueChange={(value) => setSelectedRunId(value === "__none" ? null : value)}
                >
                  <SelectTrigger className="h-8 min-w-[260px]">
                    <SelectValue placeholder="Select run" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">Select run</SelectItem>
                    {(runsForIssueQuery.data ?? []).map((run) => (
                      <SelectItem key={run.runId} value={run.runId}>
                        {formatShort(run.runId)} · {run.status} · {formatDateTime(run.createdAt)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="mb-3 overflow-x-auto rounded-md border border-border">
                <table className="min-w-full text-xs">
                  <thead className="bg-muted/30 text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">Run</th>
                      <th className="px-3 py-2 text-left font-medium">Status</th>
                      <th className="px-3 py-2 text-left font-medium">Source</th>
                      <th className="px-3 py-2 text-left font-medium">Duration</th>
                      <th className="px-3 py-2 text-left font-medium">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(runsForIssueQuery.data ?? []).map((run) => (
                      <tr
                        key={run.runId}
                        className={cn(
                          "cursor-pointer border-t border-border hover:bg-accent/30",
                          selectedRunId === run.runId && "bg-accent/40",
                        )}
                        onClick={() => setSelectedRunId(run.runId)}
                      >
                        <td className="px-3 py-2 font-mono">{formatShort(run.runId)}</td>
                        <td className="px-3 py-2"><StatusBadge status={run.status} /></td>
                        <td className="px-3 py-2 text-muted-foreground">{run.invocationSource}</td>
                        <td className="px-3 py-2 text-muted-foreground">{normalizeRunTime(run)}s</td>
                        <td className="px-3 py-2 text-muted-foreground">
                          ${numeric(run.usageJson?.costUsd, numeric(run.usageJson?.cost_usd, 0)).toFixed(4)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {selectedRun && (
                <Tabs defaultValue="run-json">
                  <TabsList variant="line">
                    <TabsTrigger value="run-json">Run JSON</TabsTrigger>
                    <TabsTrigger value="run-log">Run Log</TabsTrigger>
                    <TabsTrigger value="artifacts">Artifacts</TabsTrigger>
                  </TabsList>

                  <TabsContent value="run-json" className="mt-2">
                    <pre className="max-h-72 overflow-y-auto rounded-md border border-border bg-muted/20 p-3 text-xs">
                      {jsonStringify({
                        runId: selectedRun.runId,
                        status: selectedRun.status,
                        invocationSource: selectedRun.invocationSource,
                        usageJson: selectedRun.usageJson,
                        resultJson: selectedRun.resultJson,
                      })}
                    </pre>
                  </TabsContent>

                  <TabsContent value="run-log" className="mt-2">
                    <pre className="max-h-72 overflow-y-auto rounded-md border border-border bg-neutral-950 p-3 font-mono text-xs text-neutral-100">
                      {runLogQuery.data?.content ?? "No log content available for this run."}
                    </pre>
                  </TabsContent>

                  <TabsContent value="artifacts" className="mt-2 space-y-3">
                    {deploymentVisibility && (
                      <div className="rounded-md border border-green-500/35 bg-green-500/5 p-3">
                        <h4 className="text-sm font-semibold text-green-700">Your landing page is live</h4>
                        <div className="mt-2 grid gap-2 text-xs md:grid-cols-3">
                          <div>
                            <div className="text-muted-foreground">Live URL</div>
                            <a
                              href={deploymentVisibility.deploymentUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="break-all text-cyan-600 hover:underline"
                            >
                              {deploymentVisibility.deploymentUrl}
                            </a>
                          </div>
                          <div>
                            <div className="text-muted-foreground">Deployment status</div>
                            <div className="font-medium capitalize">{deploymentVisibility.status}</div>
                          </div>
                          <div>
                            <div className="text-muted-foreground">Timestamp</div>
                            <div className="font-medium">{formatDateTime(deploymentVisibility.timestamp)}</div>
                          </div>
                        </div>
                      </div>
                    )}

                    <div className="rounded-md border border-border p-3">
                      <h4 className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                        Run Result Artifact Candidates
                      </h4>
                      {artifactCandidates.length === 0 && (
                        <p className="text-sm text-muted-foreground">No artifact references found in resultJson.</p>
                      )}
                      {artifactCandidates.length > 0 && (
                        <ul className="space-y-1 text-xs">
                          {artifactCandidates.map((entry) => (
                            <li key={`${entry.key}:${entry.value}`} className="flex items-start gap-2">
                              <span className="text-muted-foreground">{entry.key}</span>
                              <span className="break-all">{entry.value}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>

                    <div className="rounded-md border border-border p-3">
                      <h4 className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                        Issue Attachments
                      </h4>
                      {(attachmentsQuery.data ?? []).length === 0 && (
                        <p className="text-sm text-muted-foreground">No issue attachments yet.</p>
                      )}
                      {(attachmentsQuery.data ?? []).length > 0 && (
                        <div className="space-y-2">
                          {(attachmentsQuery.data ?? []).map((attachment) => (
                            <div key={attachment.id} className="rounded-md border border-border/70 p-2 text-xs">
                              <div className="flex items-center justify-between gap-2">
                                <span className="font-medium">{attachment.originalFilename ?? attachment.objectKey}</span>
                                <a
                                  href={attachment.contentPath}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="text-cyan-600 hover:underline"
                                >
                                  Open
                                </a>
                              </div>
                              <div className="mt-1 text-muted-foreground">
                                {attachment.contentType} · {Math.round(attachment.byteSize / 1024)} KB
                              </div>
                              {attachment.contentType.startsWith("image/") && (
                                <img
                                  src={attachment.contentPath}
                                  alt={attachment.originalFilename ?? attachment.objectKey}
                                  className="mt-2 max-h-44 rounded border border-border object-contain"
                                />
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </TabsContent>
                </Tabs>
              )}
            </>
          )}
        </Section>
      </div>

      <div className="grid gap-4 xl:grid-cols-12">
        <Section title="Agent Network Graph" icon={Network} className="xl:col-span-5">
          {agentNetwork.nodes.length === 0 ? (
            <p className="py-6 text-sm text-muted-foreground">No active agents to graph.</p>
          ) : (
            <>
              <svg
                viewBox={`0 0 ${agentNetworkLayout.width} ${agentNetworkLayout.height}`}
                className="h-72 w-full rounded-md border border-border/70 bg-muted/20"
              >
                {agentNetwork.edges.map((edge) => {
                  const from = agentNetworkLayout.points.get(edge.from);
                  const to = agentNetworkLayout.points.get(edge.to);
                  if (!from || !to) return null;
                  return (
                    <line
                      key={`${edge.from}:${edge.to}:${edge.via}`}
                      x1={from.x}
                      y1={from.y}
                      x2={to.x}
                      y2={to.y}
                      stroke="currentColor"
                      strokeOpacity={0.35}
                      strokeWidth={1 + Math.min(3, edge.count)}
                      className="text-cyan-500"
                    />
                  );
                })}
                {agentNetwork.nodes.map((node) => {
                  const point = agentNetworkLayout.points.get(node.id);
                  if (!point) return null;
                  const dotClass =
                    node.status === "running"
                      ? "text-cyan-500"
                      : node.status === "paused"
                        ? "text-amber-500"
                        : node.status === "error" || node.status === "failed"
                          ? "text-red-500"
                          : "text-green-500";
                  return (
                    <g key={node.id}>
                      <circle cx={point.x} cy={point.y} r={13} className={cn("fill-current", dotClass)} />
                      <text x={point.x} y={point.y + 30} textAnchor="middle" className="fill-muted-foreground text-[11px]">
                        {truncateText(node.label, 16)}
                      </text>
                    </g>
                  );
                })}
              </svg>

              <div className="mt-2 max-h-28 space-y-1 overflow-y-auto rounded-md border border-border p-2 text-xs">
                {agentNetwork.edges.length === 0 && (
                  <p className="text-muted-foreground">No observed handoffs yet.</p>
                )}
                {agentNetwork.edges.map((edge) => (
                  <div key={`edge-row-${edge.from}-${edge.to}-${edge.via}`} className="flex items-center gap-2 text-muted-foreground">
                    <span>{truncateText(agentNetwork.nodes.find((node) => node.id === edge.from)?.label ?? edge.from, 18)}</span>
                    <ArrowRight className="h-3 w-3" />
                    <span>{truncateText(agentNetwork.nodes.find((node) => node.id === edge.to)?.label ?? edge.to, 18)}</span>
                    <span className="ml-auto">{edge.count} handoff{edge.count === 1 ? "" : "s"}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </Section>

        <Section title="Decision History" icon={GitBranch} className="xl:col-span-7">
          {decisionHistory.length === 0 ? (
            <p className="py-6 text-sm text-muted-foreground">No governance decisions captured yet.</p>
          ) : (
            <div className="max-h-[24rem] space-y-2 overflow-y-auto pr-1">
              {decisionHistory.map((item) => (
                <div key={item.id} className="rounded-md border border-border/70 bg-muted/20 p-2 text-xs">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        "h-2 w-2 rounded-full",
                        item.tone === "good"
                          ? "bg-green-500"
                          : item.tone === "bad"
                            ? "bg-red-500"
                            : item.tone === "warn"
                              ? "bg-amber-500"
                              : "bg-muted-foreground",
                      )}
                    />
                    <span className="font-medium">{item.title}</span>
                    <span className="ml-auto text-muted-foreground">{timeAgo(item.at)}</span>
                  </div>
                  <p className="mt-1 text-muted-foreground">{item.detail}</p>
                </div>
              ))}
            </div>
          )}
        </Section>
      </div>

      <div className="grid gap-4 xl:grid-cols-12">
        <Section title="System Health + Logs" icon={Cpu} className="xl:col-span-5">
          <div className="grid gap-2 md:grid-cols-2">
            <div className="rounded-md border border-border bg-muted/20 p-3">
              <div className="text-xs text-muted-foreground">Service Status</div>
              <div className="mt-1 text-sm font-medium">{healthQuery.data?.status ?? "unknown"}</div>
            </div>
            <div className="rounded-md border border-border bg-muted/20 p-3">
              <div className="text-xs text-muted-foreground">Deployment Mode</div>
              <div className="mt-1 text-sm font-medium">{healthQuery.data?.deploymentMode ?? "unknown"}</div>
            </div>
            <div className="rounded-md border border-border bg-muted/20 p-3">
              <div className="text-xs text-muted-foreground">Bootstrap</div>
              <div className="mt-1 text-sm font-medium">{healthQuery.data?.bootstrapStatus ?? "n/a"}</div>
            </div>
            <div className="rounded-md border border-border bg-muted/20 p-3">
              <div className="text-xs text-muted-foreground">Exposure</div>
              <div className="mt-1 text-sm font-medium">{healthQuery.data?.deploymentExposure ?? "unknown"}</div>
            </div>
          </div>

          <Input
            className="mt-3"
            value={systemFilter}
            onChange={(event) => setSystemFilter(event.target.value)}
            placeholder="Filter governance/ai/system logs"
          />
          <div className="mt-2 max-h-80 space-y-1 overflow-y-auto rounded-md border border-border p-2 font-mono text-xs">
            {systemLog.length === 0 && (
              <p className="py-4 text-center font-sans text-sm text-muted-foreground">No system log entries.</p>
            )}
            {systemLog.map((event: ActivityEvent) => (
              <div key={event.id} className="rounded-sm border border-border/60 p-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate">{event.action}</span>
                  <span className="text-muted-foreground">{new Date(event.createdAt).toLocaleTimeString()}</span>
                </div>
                <div className="mt-1 text-muted-foreground">
                  {event.entityType}:{formatShort(event.entityId)} · run {formatShort(event.runId)}
                </div>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Metrics + Decision Reasoning" icon={Gauge} className="xl:col-span-7">
          <div className="mb-3 rounded-md border border-border p-3">
            <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Metrics to Decision to Action</h4>
            {causalityRows.length === 0 && (
              <p className="mt-2 text-sm text-muted-foreground">No causal chain yet. Run decision cycle to generate actions.</p>
            )}
            {causalityRows.length > 0 && (
              <div className="mt-2 space-y-2">
                {causalityRows.map((row) => (
                  <div key={row.id} className="rounded border border-border/70 bg-muted/20 p-2 text-xs">
                    <div className="flex items-center gap-2 font-medium">
                      <span>{row.metricLabel}</span>
                      <span className="text-muted-foreground">{row.metricValue}</span>
                      <ArrowRight className="h-3 w-3 text-muted-foreground" />
                      <span>
                        Credits {row.creditsAfterCents != null ? `$${(row.creditsAfterCents / 100).toFixed(2)}` : "updated"}
                      </span>
                      <ArrowRight className="h-3 w-3 text-muted-foreground" />
                      <span>{row.decision}</span>
                      <ArrowRight className="h-3 w-3 text-muted-foreground" />
                      <span>{row.issueLabel}</span>
                      <span className={cn("rounded px-1.5 py-0.5 text-[10px]", row.actionSuccess ? "bg-green-500/15 text-green-700" : "bg-amber-500/15 text-amber-700")}>
                        {row.actionSuccess ? "executed" : "not-executed"}
                      </span>
                    </div>
                    <div className="mt-1 text-muted-foreground">Action: {row.action}</div>
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      Provider {row.provider} · dispatch {row.dispatchMode}
                      {row.dispatchJobId ? ` (${truncateText(row.dispatchJobId, 18)})` : ""}
                      {row.sessionId ? ` · session ${truncateText(row.sessionId, 14)}` : ""}
                      {row.issueStatus ? ` · issue ${row.issueStatus}` : ""}
                    </div>
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      Wallet after payment: credits {row.creditsAfterCents != null ? `$${(row.creditsAfterCents / 100).toFixed(2)}` : "-"}
                      {row.revenueAfterCents != null ? ` · revenue $${(row.revenueAfterCents / 100).toFixed(2)}` : ""}
                      {row.spentAfterCents != null ? ` · spent $${(row.spentAfterCents / 100).toFixed(2)}` : ""}
                    </div>
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      Duplicates ignored: {row.duplicateCount} · {timeAgo(row.happenedAt)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="grid gap-2 md:grid-cols-3">
            {metricSignals.map((signal) => (
              <div key={signal.key} className="rounded-md border border-border bg-muted/20 p-3">
                <div className="text-xs text-muted-foreground">{signal.label}</div>
                <div className="mt-1 text-sm font-medium">{signal.valueLabel}</div>
              </div>
            ))}
          </div>

          <div className="mt-3 rounded-md border border-border p-3">
            <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Business Output Layer</h4>
            <div className="mt-2 grid gap-2 md:grid-cols-3">
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">Provider</span>
                <Select value={billingProvider} onValueChange={(value) => setBillingProvider(value === "dodo" ? "dodo" : "stripe")}>
                  <SelectTrigger className="h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="stripe">Stripe</SelectItem>
                    <SelectItem value="dodo">Dodo</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">Amount (USD)</span>
                <Input
                  value={billingAmountUsd}
                  onChange={(event) => setBillingAmountUsd(event.target.value)}
                  placeholder="49"
                  className="h-8"
                />
              </div>
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">30-day Revenue</span>
                <div className="flex h-8 items-center rounded-md border border-border bg-muted/20 px-2 text-sm font-medium">
                  ${(numeric(billingRevenueQuery.data?.revenueCents, 0) / 100).toFixed(2)}
                </div>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                disabled={createCheckoutSessionMutation.isPending}
                onClick={() => createCheckoutSessionMutation.mutate()}
              >
                {createCheckoutSessionMutation.isPending
                  ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  : <DollarSign className="mr-2 h-4 w-4" />}
                Create checkout
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={reportPaymentSuccessMutation.isPending}
                onClick={() => reportPaymentSuccessMutation.mutate()}
              >
                {reportPaymentSuccessMutation.isPending
                  ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  : <CheckCircle2 className="mr-2 h-4 w-4" />}
                Simulate success webhook
              </Button>
            </div>

            {latestCheckout && (
              <div className="mt-2 rounded-md border border-border/70 bg-muted/20 p-2 text-xs">
                <div className="text-muted-foreground">Session {formatShort(latestCheckout.sessionId, 12)} created.</div>
                {latestCheckout.checkoutUrl ? (
                  <a href={latestCheckout.checkoutUrl} target="_blank" rel="noreferrer" className="mt-1 inline-flex text-cyan-600 hover:underline">
                    Open checkout URL
                  </a>
                ) : (
                  <div className="mt-1 text-muted-foreground">No checkout URL returned by provider.</div>
                )}
              </div>
            )}

            {latestRevenuePing && (
              <div className="mt-2 rounded-md border border-border/70 bg-muted/20 p-2 text-xs text-muted-foreground">
                Revenue metric updated by webhook: ${(latestRevenuePing.amountCents / 100).toFixed(2)} at {formatDateTime(latestRevenuePing.at)}
              </div>
            )}

            {(createCheckoutSessionMutation.error || reportPaymentSuccessMutation.error) && (
              <p className="mt-2 text-sm text-destructive">
                {(createCheckoutSessionMutation.error as Error | null)?.message ??
                  (reportPaymentSuccessMutation.error as Error | null)?.message}
              </p>
            )}

            <div className="mt-3 grid gap-2 md:grid-cols-3">
              <div className="rounded-md border border-border bg-muted/20 p-3">
                <div className="text-xs text-muted-foreground">Credits</div>
                <div className="mt-1 text-sm font-medium">
                  ${(numeric(billingFinanceQuery.data?.creditsCents, 0) / 100).toFixed(2)}
                </div>
              </div>
              <div className="rounded-md border border-border bg-muted/20 p-3">
                <div className="text-xs text-muted-foreground">Revenue</div>
                <div className="mt-1 text-sm font-medium">
                  ${(numeric(billingFinanceQuery.data?.revenueCents, 0) / 100).toFixed(2)}
                </div>
              </div>
              <div className="rounded-md border border-border bg-muted/20 p-3">
                <div className="text-xs text-muted-foreground">Spent</div>
                <div className="mt-1 text-sm font-medium">
                  ${(numeric(billingFinanceQuery.data?.spentCents, 0) / 100).toFixed(2)}
                </div>
              </div>
            </div>
          </div>

          <div className="mt-3 rounded-md border border-border p-3">
            <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Idempotency Visibility</h4>
            {idempotencyRows.length === 0 && (
              <p className="mt-2 text-sm text-muted-foreground">No duplicate webhook deliveries observed yet.</p>
            )}
            {idempotencyRows.length > 0 && (
              <div className="mt-2 max-h-44 space-y-1 overflow-y-auto text-xs">
                {idempotencyRows.map((row) => (
                  <div key={row.id} className="rounded border border-border/70 bg-muted/20 p-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">Duplicate ignored · {row.provider}</span>
                      <span className="text-muted-foreground">{timeAgo(row.at)}</span>
                    </div>
                    <div className="mt-1 text-muted-foreground">
                      Session {truncateText(row.sessionId, 14)} · ${ (row.amountCents / 100).toFixed(2) }
                    </div>
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      Transaction key {truncateText(row.transactionKey, 18)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="mt-3 grid gap-2 md:grid-cols-2">
            <div className="rounded-md border border-border p-3">
              <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">System Metrics Snapshot</h4>
              <pre className="mt-2 max-h-48 overflow-y-auto rounded bg-muted/20 p-2 text-xs">
                {jsonStringify(systemMetricsQuery.data?.snapshot ?? {})}
              </pre>
            </div>

            <div className="rounded-md border border-border p-3">
              <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Goal Containment</h4>
              <pre className="mt-2 max-h-48 overflow-y-auto rounded bg-muted/20 p-2 text-xs">
                {jsonStringify(governanceApi && summary.goalStats
                  ? {
                      activeGoals: summary.goalStats.active,
                      failedGoals: summary.goalStats.failed,
                      cancelledGoals: summary.goalStats.cancelled,
                      planningGoals: summary.goalStats.planning,
                    }
                  : {})}
              </pre>
            </div>
          </div>

          <div className="mt-3 rounded-md border border-border p-3">
            <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Pending Feedback Actions</h4>
            {(feedbackActionsQuery.data ?? []).length === 0 && (
              <p className="mt-2 text-sm text-muted-foreground">No pending feedback actions.</p>
            )}
            {(feedbackActionsQuery.data ?? []).length > 0 && (
              <div className="mt-2 max-h-36 space-y-1 overflow-y-auto text-xs">
                {(feedbackActionsQuery.data ?? []).slice(0, 30).map((action, idx) => (
                  <div key={idx} className="rounded border border-border/70 bg-muted/20 p-2">
                    {jsonStringify(action)}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="mt-3 rounded-md border border-border p-3">
            <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Last Decision Cycle Result</h4>
            <pre className="mt-2 max-h-48 overflow-y-auto rounded bg-muted/20 p-2 text-xs">
              {jsonStringify(decisionResult ?? { message: "Run decision cycle to capture reasoning output." })}
            </pre>
          </div>
        </Section>
      </div>
    </div>
  );
}
