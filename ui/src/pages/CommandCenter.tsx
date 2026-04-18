import { useEffect, useMemo, useState } from "react";
import {
  AUTONOMY_LEVELS,
  CYCLE_MODES,
  DECISION_MODES,
  TRAFFIC_CHANNELS,
  TRAFFIC_MODES,
  type AutonomyLevel,
  type CycleMode,
  type DecisionMode,
  type TrafficChannel,
  type TrafficMode,
  type UpdateSystemControls,
} from "@paperclipai/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Bot,
  CircleDot,
  Gauge,
  ListFilter,
  RefreshCw,
  Rocket,
  Settings2,
  ShieldCheck,
  TerminalSquare,
  TrendingUp,
  Waves,
  Check,
  X,
  PlayCircle,
} from "lucide-react";
import {
  systemControlsApi,
  type ExecutionFeedEventResponse,
  type SystemControlsResponse,
} from "../api/system-controls";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { StatusBadge } from "../components/StatusBadge";
import { ExecutionStatusBadge } from "../components/ExecutionStatusBadge";
import { queryKeys } from "../lib/queryKeys";
import {
  extractEvidence,
  formatRelativeTime,
  getEventReason,
  getTraceLink,
  groupExecutionFeed,
  summarizeFeedSpam,
} from "../lib/execution-feed";

interface ControlsDraft {
  trafficEnabled: boolean;
  redditEnabled: boolean;
  twitterEnabled: boolean;
  indieHackersEnabled: boolean;
  hackerNewsEnabled: boolean;
  maxMultiplier: number;
  postFrequency: number;
  subredditTargetsText: string;
  trafficChannels: TrafficChannel[];
  trafficMultiplier: number;
  trafficPostIntervalMs: number;
  trafficMaxPostsPerCycle: number;
  trafficSubredditWhitelistText: string;
  trafficMode: TrafficMode;
  decisionMode: DecisionMode;
  pricingVariant: string;
  paywallTriggerCount: number;
  cycleMode: CycleMode;
  autonomyLevel: AutonomyLevel;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function parseSubreddits(text: string): string[] {
  return text
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .slice(0, 20);
}

const CHANNEL_KEY_MAP: Record<TrafficChannel, keyof Pick<ControlsDraft, "redditEnabled" | "twitterEnabled" | "indieHackersEnabled" | "hackerNewsEnabled">> = {
  reddit: "redditEnabled",
  twitter: "twitterEnabled",
  indie_hackers: "indieHackersEnabled",
  hacker_news: "hackerNewsEnabled",
};

function deriveTrafficChannels(controls: SystemControlsResponse): TrafficChannel[] {
  const channels = Array.isArray(controls.trafficChannels)
    ? controls.trafficChannels
    : [];
  if (channels.length > 0) return channels;

  const fallback: TrafficChannel[] = [];
  if (controls.redditEnabled) fallback.push("reddit");
  if (controls.twitterEnabled) fallback.push("twitter");
  if (controls.indieHackersEnabled) fallback.push("indie_hackers");
  if (controls.hackerNewsEnabled) fallback.push("hacker_news");
  return fallback;
}

function toDraft(controls: SystemControlsResponse): ControlsDraft {
  return {
    trafficEnabled: controls.trafficEnabled,
    redditEnabled: controls.redditEnabled,
    twitterEnabled: controls.twitterEnabled,
    indieHackersEnabled: controls.indieHackersEnabled,
    hackerNewsEnabled: controls.hackerNewsEnabled,
    maxMultiplier: controls.maxMultiplier,
    postFrequency: controls.postFrequency,
    subredditTargetsText: controls.subredditTargets.join(", "),
    trafficChannels: deriveTrafficChannels(controls),
    trafficMultiplier: controls.trafficMultiplier,
    trafficPostIntervalMs: controls.trafficPostIntervalMs,
    trafficMaxPostsPerCycle: controls.trafficMaxPostsPerCycle,
    trafficSubredditWhitelistText: controls.trafficSubredditWhitelist.join(", "),
    trafficMode: controls.trafficMode,
    decisionMode: controls.decisionMode,
    pricingVariant: controls.pricingVariant,
    paywallTriggerCount: controls.paywallTriggerCount,
    cycleMode: controls.cycleMode,
    autonomyLevel: controls.autonomyLevel,
  };
}

function toUpdatePayload(draft: ControlsDraft): UpdateSystemControls {
  return {
    trafficEnabled: draft.trafficEnabled,
    redditEnabled: draft.redditEnabled,
    twitterEnabled: draft.twitterEnabled,
    indieHackersEnabled: draft.indieHackersEnabled,
    hackerNewsEnabled: draft.hackerNewsEnabled,
    maxMultiplier: clampInt(draft.maxMultiplier, 1, 20),
    postFrequency: clampInt(draft.postFrequency, 1, 24),
    subredditTargets: parseSubreddits(draft.subredditTargetsText),
    trafficChannels: draft.trafficChannels,
    trafficMultiplier: clampInt(draft.trafficMultiplier, 1, 20),
    trafficPostIntervalMs: clampInt(draft.trafficPostIntervalMs, 5_000, 3_600_000),
    trafficMaxPostsPerCycle: clampInt(draft.trafficMaxPostsPerCycle, 1, 40),
    trafficSubredditWhitelist: parseSubreddits(draft.trafficSubredditWhitelistText),
    trafficMode: draft.trafficMode,
    decisionMode: draft.decisionMode,
    pricingVariant: draft.pricingVariant.trim() || "entry_9",
    paywallTriggerCount: clampInt(draft.paywallTriggerCount, 1, 50),
    cycleMode: draft.cycleMode,
    autonomyLevel: draft.autonomyLevel,
  };
}

function draftEquals(a: ControlsDraft, b: ControlsDraft): boolean {
  return (
    a.trafficEnabled === b.trafficEnabled
    && a.redditEnabled === b.redditEnabled
    && a.twitterEnabled === b.twitterEnabled
    && a.indieHackersEnabled === b.indieHackersEnabled
    && a.hackerNewsEnabled === b.hackerNewsEnabled
    && a.maxMultiplier === b.maxMultiplier
    && a.postFrequency === b.postFrequency
    && a.subredditTargetsText === b.subredditTargetsText
    && a.trafficChannels.join(",") === b.trafficChannels.join(",")
    && a.trafficMultiplier === b.trafficMultiplier
    && a.trafficPostIntervalMs === b.trafficPostIntervalMs
    && a.trafficMaxPostsPerCycle === b.trafficMaxPostsPerCycle
    && a.trafficSubredditWhitelistText === b.trafficSubredditWhitelistText
    && a.trafficMode === b.trafficMode
    && a.decisionMode === b.decisionMode
    && a.pricingVariant === b.pricingVariant
    && a.paywallTriggerCount === b.paywallTriggerCount
    && a.cycleMode === b.cycleMode
    && a.autonomyLevel === b.autonomyLevel
  );
}

function formatDurationMs(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "-";
  if (value < 1000) return `${value}ms`;
  return `${(value / 1000).toFixed(1)}s`;
}

function formatDateTime(value: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString();
}

function metricSummary(
  metricName: string | null,
  metricValue: number | null,
  thresholdValue: number | null,
): string {
  if (!metricName) return "No metric evidence";
  if (metricValue == null) return metricName;
  if (thresholdValue == null) return `${metricName}: ${metricValue}`;
  return `${metricName}: ${metricValue} (threshold ${thresholdValue})`;
}

function formatNumericMetric(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "n/a";
  if (Math.abs(value) >= 100) return value.toFixed(0);
  if (Math.abs(value) >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

function safeText(value: unknown, fallback = "-"): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function toActionLabel(actionType: unknown, actionKey: unknown): string {
  const normalizedType = safeText(actionType).replace(/_/g, " ");
  const normalizedKey = safeText(actionKey).replace(/_/g, " ").replace(/\./g, " ");
  return `${normalizedType} (${normalizedKey})`;
}

function toFeedRowLabel(event: ExecutionFeedEventResponse): string {
  const details =
    event.details && typeof event.details === "object"
      ? (event.details as Record<string, unknown>)
      : null;
  if (details && typeof details.message === "string" && details.message.trim().length > 0) {
    return details.message;
  }
  const message = safeText(event.message, "");
  if (message) return message;
  return safeText(event.action);
}

export function CommandCenter() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<ControlsDraft | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [feedCategoryFilter, setFeedCategoryFilter] = useState<string>("all");
  const [feedStatusFilter, setFeedStatusFilter] = useState<string>("all");
  const [feedBuffer, setFeedBuffer] = useState<ExecutionFeedEventResponse[]>([]);
  const [intentText, setIntentText] = useState("");

  useEffect(() => {
    setBreadcrumbs([{ label: "Command Center" }]);
  }, [setBreadcrumbs]);

  const controlsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.systemControls(selectedCompanyId) : ["system-controls", "none"],
    queryFn: () => systemControlsApi.getControls(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 10_000,
  });

  const decisionsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.systemDecisions(selectedCompanyId, 120) : ["system-decisions", "none", 120],
    queryFn: () => systemControlsApi.listDecisions(selectedCompanyId!, 120),
    enabled: !!selectedCompanyId,
    refetchInterval: 6_000,
  });

  const cycleStateQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.cycleState(selectedCompanyId) : ["cycle-state", "none"],
    queryFn: () => systemControlsApi.getCycleState(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 4_000,
  });

  const executionFeedQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.executionFeed(
        selectedCompanyId,
        feedCategoryFilter,
        feedStatusFilter,
        120,
      )
      : ["execution-feed", "none"],
    queryFn: () => systemControlsApi.getExecutionFeed(selectedCompanyId!, {
      limit: 120,
      categories: feedCategoryFilter === "all" ? [] : [feedCategoryFilter],
      statuses: feedStatusFilter === "all" ? [] : [feedStatusFilter],
    }),
    enabled: !!selectedCompanyId,
    refetchInterval: 8_000,
  });

  useEffect(() => {
    if (!controlsQuery.data || isDirty) return;
    const nextDraft = toDraft(controlsQuery.data);
    setDraft((current) => {
      if (!current) return nextDraft;
      return draftEquals(current, nextDraft) ? current : nextDraft;
    });
    setIsDirty(false);
  }, [controlsQuery.data, isDirty]);

  useEffect(() => {
    if (!executionFeedQuery.data) return;
    setFeedBuffer(executionFeedQuery.data);
  }, [executionFeedQuery.data]);

  useEffect(() => {
    if (!selectedCompanyId) return;

    const params = new URLSearchParams();
    params.set("limit", "80");
    if (feedCategoryFilter !== "all") params.set("categories", feedCategoryFilter);
    if (feedStatusFilter !== "all") params.set("statuses", feedStatusFilter);

    const stream = new EventSource(
      `/api/companies/${encodeURIComponent(selectedCompanyId)}/execution-feed/stream?${params.toString()}`,
    );

    const onSnapshot = (event: MessageEvent) => {
      try {
        const parsed = JSON.parse(event.data) as ExecutionFeedEventResponse[];
        if (Array.isArray(parsed)) {
          setFeedBuffer(parsed.slice(0, 120));
        }
      } catch {
        // ignore stream parse errors
      }
    };

    const onUpdate = (event: MessageEvent) => {
      try {
        const parsed = JSON.parse(event.data) as ExecutionFeedEventResponse;
        if (!parsed || typeof parsed.id !== "string") return;
        setFeedBuffer((current) => {
          if (current.some((row) => row.id === parsed.id)) return current;
          return [parsed, ...current].slice(0, 120);
        });
      } catch {
        // ignore stream parse errors
      }
    };

    stream.addEventListener("snapshot", onSnapshot);
    stream.addEventListener("update", onUpdate);

    return () => {
      stream.removeEventListener("snapshot", onSnapshot);
      stream.removeEventListener("update", onUpdate);
      stream.close();
    };
  }, [selectedCompanyId, feedCategoryFilter, feedStatusFilter]);

  const saveControlsMutation = useMutation({
    mutationFn: (nextDraft: ControlsDraft) =>
      systemControlsApi.updateControls(selectedCompanyId!, toUpdatePayload(nextDraft)),
    onSuccess: (updated) => {
      setDraft(toDraft(updated));
      setIsDirty(false);
      if (!selectedCompanyId) return;
      queryClient.invalidateQueries({ queryKey: queryKeys.systemControls(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.systemDecisions(selectedCompanyId, 120) });
      queryClient.invalidateQueries({ queryKey: queryKeys.cycleState(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: ["execution-feed", selectedCompanyId] });
      queryClient.invalidateQueries({ queryKey: queryKeys.aiDashboard(selectedCompanyId) });
    },
  });

  const approveMutation = useMutation({
    mutationFn: (decisionId: string) =>
      systemControlsApi.approveDecision(selectedCompanyId!, decisionId),
    onSuccess: () => {
      if (!selectedCompanyId) return;
      queryClient.invalidateQueries({ queryKey: queryKeys.systemDecisions(selectedCompanyId, 120) });
      queryClient.invalidateQueries({ queryKey: queryKeys.systemControls(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.cycleState(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: ["execution-feed", selectedCompanyId] });
      queryClient.invalidateQueries({ queryKey: queryKeys.aiDashboard(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(selectedCompanyId) });
    },
  });

  const rejectMutation = useMutation({
    mutationFn: (decisionId: string) =>
      systemControlsApi.rejectDecision(selectedCompanyId!, decisionId, "rejected by command center operator"),
    onSuccess: () => {
      if (!selectedCompanyId) return;
      queryClient.invalidateQueries({ queryKey: queryKeys.systemDecisions(selectedCompanyId, 120) });
      queryClient.invalidateQueries({ queryKey: queryKeys.systemControls(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.cycleState(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: ["execution-feed", selectedCompanyId] });
      queryClient.invalidateQueries({ queryKey: queryKeys.aiDashboard(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(selectedCompanyId) });
    },
  });

  const runCycleMutation = useMutation({
    mutationFn: (cycleType: CycleMode) =>
      systemControlsApi.runCycle(selectedCompanyId!, cycleType, "manual_cycle_run_from_command_center"),
    onSuccess: () => {
      if (!selectedCompanyId) return;
      queryClient.invalidateQueries({ queryKey: queryKeys.systemControls(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.systemDecisions(selectedCompanyId, 120) });
      queryClient.invalidateQueries({ queryKey: queryKeys.cycleState(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: ["execution-feed", selectedCompanyId] });
      queryClient.invalidateQueries({ queryKey: queryKeys.aiDashboard(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(selectedCompanyId) });
    },
  });

  const runIntentCycleMutation = useMutation({
    mutationFn: (intent: string) =>
      systemControlsApi.runCycleFromIntent(selectedCompanyId!, intent, "intent_to_cycle_mapping"),
    onSuccess: () => {
      if (!selectedCompanyId) return;
      setIntentText("");
      queryClient.invalidateQueries({ queryKey: queryKeys.systemControls(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.systemDecisions(selectedCompanyId, 120) });
      queryClient.invalidateQueries({ queryKey: queryKeys.cycleState(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: ["execution-feed", selectedCompanyId] });
      queryClient.invalidateQueries({ queryKey: queryKeys.aiDashboard(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(selectedCompanyId) });
    },
  });

  const canSave = !!draft && isDirty && !saveControlsMutation.isPending;
  const decisions = decisionsQuery.data ?? [];

  const pendingDecisions = useMemo(
    () => decisions.filter((item) => item.status === "pending" || item.status === "awaiting_approval"),
    [decisions],
  );

  const groupedFeed = useMemo(() => groupExecutionFeed(feedBuffer, 80), [feedBuffer]);
  const feedSpamSummary = useMemo(() => summarizeFeedSpam(feedBuffer), [feedBuffer]);
  const explanationEvent = groupedFeed[0]?.event ?? feedBuffer[0] ?? null;
  const explanationTrace = explanationEvent ? getTraceLink(explanationEvent) : null;
  const surfacedOutputs = useMemo(() => {
    const dedupe = new Set<string>();
    const rows: Array<{ event: ExecutionFeedEventResponse; label: string; url: string }> = [];
    for (const event of feedBuffer) {
      const evidence = extractEvidence(event);
      if (!evidence?.url) continue;
      const key = `${evidence.type}:${evidence.url}`;
      if (dedupe.has(key)) continue;
      dedupe.add(key);
      rows.push({ event, label: evidence.label, url: evidence.url });
      if (rows.length >= 4) break;
    }
    return rows;
  }, [feedBuffer]);

  const lastSync = Math.max(controlsQuery.dataUpdatedAt, decisionsQuery.dataUpdatedAt);

  if (!selectedCompanyId) {
    return <EmptyState icon={Settings2} message="Select a company to open the command center." />;
  }

  if (controlsQuery.isLoading && !draft) {
    return <PageSkeleton variant="dashboard" />;
  }

  if (!draft) {
    return <EmptyState icon={Settings2} message="Command center controls are unavailable right now." />;
  }

  const mutateDraft = <K extends keyof ControlsDraft>(key: K, value: ControlsDraft[K]) => {
    setDraft((current) => {
      if (!current) return current;
      return { ...current, [key]: value };
    });
    setIsDirty(true);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-border bg-card px-4 py-4">
        <div>
          <h1 className="text-lg font-semibold text-foreground">Command Center</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Runtime control plane for cycle mode, growth channels, conversion policy, and autonomous decision overrides.
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            Last sync: {lastSync > 0 ? new Date(lastSync).toLocaleTimeString() : "-"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              controlsQuery.refetch();
              decisionsQuery.refetch();
              cycleStateQuery.refetch();
              executionFeedQuery.refetch();
            }}
            disabled={
              controlsQuery.isFetching
              || decisionsQuery.isFetching
              || cycleStateQuery.isFetching
              || executionFeedQuery.isFetching
            }
          >
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            Refresh
          </Button>
          <Button
            size="sm"
            onClick={() => draft && saveControlsMutation.mutate(draft)}
            disabled={!canSave}
          >
            {saveControlsMutation.isPending ? "Saving..." : "Apply Runtime Controls"}
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <div className="rounded-xl border border-border bg-card px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Cycle Mode</div>
          <div className="mt-2 flex items-center gap-2 text-sm">
            <Rocket className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium text-foreground">{draft.cycleMode}</span>
          </div>
        </div>
        <div className="rounded-xl border border-border bg-card px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Autonomy</div>
          <div className="mt-2 flex items-center gap-2 text-sm">
            <ShieldCheck className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium text-foreground">{draft.autonomyLevel}</span>
          </div>
        </div>
        <div className="rounded-xl border border-border bg-card px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Pending Decisions</div>
          <div className="mt-2 flex items-center gap-2 text-sm">
            <Gauge className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium text-foreground">{pendingDecisions.length}</span>
          </div>
        </div>
        <div className="rounded-xl border border-border bg-card px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Decision Mode</div>
          <div className="mt-2 flex items-center gap-2 text-sm">
            <ListFilter className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium text-foreground">{draft.decisionMode}</span>
          </div>
        </div>
      </div>

      <section className="space-y-3 rounded-xl border border-border bg-card p-4">
        <header>
          <h2 className="text-sm font-semibold text-foreground">System Explanation Mode</h2>
          <p className="text-xs text-muted-foreground">Single view of why the system moved, what it did, and which entities were linked.</p>
        </header>
        <div className="rounded-md border border-border bg-muted/20 px-3 py-2 text-sm text-foreground">
          {explanationEvent
            ? `${safeText(explanationEvent.message, safeText(explanationEvent.action))} (${formatRelativeTime(explanationEvent.createdAt)})`
            : "No runtime explanation yet. Trigger a cycle or wait for next autonomous event."}
        </div>
        {explanationTrace ? (
          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5">trace: {explanationTrace.traceId.slice(0, 16)}</span>
            {explanationTrace.decisionId ? <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5">decision: {explanationTrace.decisionId.slice(0, 8)}</span> : null}
            {explanationTrace.issueId ? <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5">issue: {explanationTrace.issueId.slice(0, 8)}</span> : null}
            {explanationTrace.goalId ? <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5">goal: {explanationTrace.goalId.slice(0, 8)}</span> : null}
            {explanationTrace.agentId ? <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5">agent: {explanationTrace.agentId.slice(0, 8)}</span> : null}
          </div>
        ) : null}
      </section>

      <section className="space-y-3 rounded-xl border border-border bg-card p-4">
        <header className="flex items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Forced Output Surfacing</h2>
            <p className="text-xs text-muted-foreground">Pinned external links from recent execution so output can be verified without digging through logs.</p>
          </div>
          <span className="text-xs text-muted-foreground">{surfacedOutputs.length} surfaced</span>
        </header>
        {surfacedOutputs.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
            No external outputs captured yet.
          </div>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {surfacedOutputs.map((row) => (
              <a
                key={`${row.event.id}-${row.url}`}
                href={row.url}
                target="_blank"
                rel="noreferrer"
                className="rounded-md border border-border px-3 py-2 hover:bg-accent/40"
              >
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">{row.label}</p>
                    <p className="truncate text-sm text-foreground">{row.url}</p>
                  </div>
                  <ExecutionStatusBadge status={row.event.status} />
                </div>
              </a>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3 rounded-xl border border-border bg-card p-4">
        <header className="flex items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Unified Cycle Orchestrator</h2>
            <p className="text-xs text-muted-foreground">Trigger an explicit company cycle run that executes execution, traffic, decision, and email systems in sequence.</p>
          </div>
          <PlayCircle className="h-4 w-4 text-muted-foreground" />
        </header>

        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {CYCLE_MODES.map((mode) => (
            <Button
              key={mode}
              size="sm"
              variant={mode === draft.cycleMode ? "default" : "outline"}
              onClick={() => runCycleMutation.mutate(mode)}
              disabled={runCycleMutation.isPending}
            >
              {mode === "launch" ? "Launch Cycle" : mode === "improve" ? "Improve Cycle" : mode === "scale" ? "Scale Cycle" : "Dominate Cycle"}
            </Button>
          ))}
        </div>

        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
          <Input
            placeholder="Type intent, e.g. improve conversion"
            value={intentText}
            onChange={(event) => setIntentText(event.target.value)}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={runIntentCycleMutation.isPending || intentText.trim().length < 3}
            onClick={() => runIntentCycleMutation.mutate(intentText.trim())}
          >
            Map Intent + Run
          </Button>
        </div>

        <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          {runIntentCycleMutation.isPending
            ? "Intent mapping run in progress..."
            : runIntentCycleMutation.data
              ? `Intent mapped to ${runIntentCycleMutation.data.mappedCycleType} (${runIntentCycleMutation.data.result.status})`
              : runCycleMutation.isPending
            ? "Cycle run in progress..."
            : runCycleMutation.data
              ? `Last run: ${runCycleMutation.data.cycleType} (${runCycleMutation.data.status}) in ${formatDurationMs(runCycleMutation.data.durationMs)}`
              : "No manual cycle run triggered in this session."}
        </div>
      </section>

      <div className="grid gap-4 xl:grid-cols-3">
        <section className="space-y-3 rounded-xl border border-border bg-card p-4">
          <header className="space-y-1">
            <h2 className="text-sm font-semibold text-foreground">Cycle Control</h2>
            <p className="text-xs text-muted-foreground">Control global execution mode and autonomy behavior.</p>
          </header>

          <div className="space-y-2">
            <Label htmlFor="cycle-mode">Cycle mode</Label>
            <Select
              value={draft.cycleMode}
              onValueChange={(value) => mutateDraft("cycleMode", value as CycleMode)}
            >
              <SelectTrigger id="cycle-mode" className="w-full">
                <SelectValue placeholder="Select cycle mode" />
              </SelectTrigger>
              <SelectContent>
                {CYCLE_MODES.map((mode) => (
                  <SelectItem key={mode} value={mode}>{mode}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="autonomy-level">Autonomy level</Label>
            <Select
              value={draft.autonomyLevel}
              onValueChange={(value) => mutateDraft("autonomyLevel", value as AutonomyLevel)}
            >
              <SelectTrigger id="autonomy-level" className="w-full">
                <SelectValue placeholder="Select autonomy level" />
              </SelectTrigger>
              <SelectContent>
                {AUTONOMY_LEVELS.map((mode) => (
                  <SelectItem key={mode} value={mode}>{mode}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <label className="flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2">
            <Checkbox
              checked={draft.trafficEnabled}
              onCheckedChange={(checked) => mutateDraft("trafficEnabled", checked === true)}
            />
            <div>
              <div className="text-sm font-medium text-foreground">Traffic loop enabled</div>
              <div className="text-xs text-muted-foreground">When disabled, growth cycles stop for this company.</div>
            </div>
          </label>
        </section>

        <section className="space-y-3 rounded-xl border border-border bg-card p-4">
          <header className="space-y-1">
            <h2 className="text-sm font-semibold text-foreground">Growth Control</h2>
            <p className="text-xs text-muted-foreground">Toggle channels and tune distribution pressure in real time.</p>
          </header>

          <div className="grid gap-2 sm:grid-cols-2">
            {TRAFFIC_CHANNELS.map((channel) => (
              <label key={channel} className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
                <Checkbox
                  checked={draft.trafficChannels.includes(channel)}
                  onCheckedChange={(checked) => {
                    const enabled = checked === true;
                    const nextChannels = enabled
                      ? Array.from(new Set([...draft.trafficChannels, channel])) as TrafficChannel[]
                      : draft.trafficChannels.filter((entry) => entry !== channel);
                    mutateDraft("trafficChannels", nextChannels);
                    mutateDraft(CHANNEL_KEY_MAP[channel], enabled as never);
                  }}
                />
                <span>{channel.replace(/_/g, " ")}</span>
              </label>
            ))}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="traffic-mode">Traffic mode</Label>
              <Select
                value={draft.trafficMode}
                onValueChange={(value) => mutateDraft("trafficMode", value as TrafficMode)}
              >
                <SelectTrigger id="traffic-mode" className="w-full">
                  <SelectValue placeholder="Select traffic mode" />
                </SelectTrigger>
                <SelectContent>
                  {TRAFFIC_MODES.map((mode) => (
                    <SelectItem key={mode} value={mode}>{mode}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="decision-mode">Decision mode</Label>
              <Select
                value={draft.decisionMode}
                onValueChange={(value) => mutateDraft("decisionMode", value as DecisionMode)}
              >
                <SelectTrigger id="decision-mode" className="w-full">
                  <SelectValue placeholder="Select decision mode" />
                </SelectTrigger>
                <SelectContent>
                  {DECISION_MODES.map((mode) => (
                    <SelectItem key={mode} value={mode}>{mode}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="traffic-multiplier">Traffic multiplier cap</Label>
              <Input
                id="traffic-multiplier"
                type="number"
                min={1}
                max={20}
                value={draft.trafficMultiplier}
                onChange={(event) => mutateDraft("trafficMultiplier", Number(event.target.value))}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="traffic-max-posts">Max posts / cycle</Label>
              <Input
                id="traffic-max-posts"
                type="number"
                min={1}
                max={40}
                value={draft.trafficMaxPostsPerCycle}
                onChange={(event) => mutateDraft("trafficMaxPostsPerCycle", Number(event.target.value))}
              />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="traffic-post-interval">Post interval (ms)</Label>
              <Input
                id="traffic-post-interval"
                type="number"
                min={5000}
                max={3600000}
                value={draft.trafficPostIntervalMs}
                onChange={(event) => mutateDraft("trafficPostIntervalMs", Number(event.target.value))}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="max-multiplier">Max multiplier</Label>
              <Input
                id="max-multiplier"
                type="number"
                min={1}
                max={20}
                value={draft.maxMultiplier}
                onChange={(event) => mutateDraft("maxMultiplier", Number(event.target.value))}
              />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="post-frequency">Post frequency / cycle</Label>
              <Input
                id="post-frequency"
                type="number"
                min={1}
                max={24}
                value={draft.postFrequency}
                onChange={(event) => mutateDraft("postFrequency", Number(event.target.value))}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="traffic-whitelist">Subreddit whitelist</Label>
              <Input
                id="traffic-whitelist"
                placeholder="startups, sideproject"
                value={draft.trafficSubredditWhitelistText}
                onChange={(event) => mutateDraft("trafficSubredditWhitelistText", event.target.value)}
              />
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="subreddit-targets">Subreddit targets</Label>
            <Input
              id="subreddit-targets"
              placeholder="SaaS, startups, entrepreneur"
              value={draft.subredditTargetsText}
              onChange={(event) => mutateDraft("subredditTargetsText", event.target.value)}
            />
            <p className="text-xs text-muted-foreground">Comma separated list. Empty means default channel targeting.</p>
          </div>
        </section>

        <section className="space-y-3 rounded-xl border border-border bg-card p-4">
          <header className="space-y-1">
            <h2 className="text-sm font-semibold text-foreground">Conversion Control</h2>
            <p className="text-xs text-muted-foreground">Control paywall and pricing behavior for conversion runtime.</p>
          </header>

          <div className="space-y-1">
            <Label htmlFor="pricing-variant">Pricing variant</Label>
            <Input
              id="pricing-variant"
              value={draft.pricingVariant}
              onChange={(event) => mutateDraft("pricingVariant", event.target.value)}
              placeholder="entry_9"
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="paywall-trigger">Paywall trigger count</Label>
            <Input
              id="paywall-trigger"
              type="number"
              min={1}
              max={50}
              value={draft.paywallTriggerCount}
              onChange={(event) => mutateDraft("paywallTriggerCount", Number(event.target.value))}
            />
          </div>

          <div className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">Execution policy</p>
            <p className="mt-1">Autonomy level controls baseline execution. Decision mode adds strict approval policy for high-impact actions and traffic scale events.</p>
          </div>
        </section>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <section className="space-y-3 rounded-xl border border-border bg-card p-4">
          <header className="flex items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-foreground">Decision Transparency</h2>
              <p className="text-xs text-muted-foreground">Live stream of autonomous decisions with operator override controls.</p>
            </div>
            <StatusBadge status={pendingDecisions.length > 0 ? "pending" : "active"} />
          </header>

          {decisionsQuery.isLoading ? (
            <PageSkeleton variant="list" />
          ) : decisions.length === 0 ? (
            <p className="rounded-md border border-dashed border-border px-3 py-5 text-sm text-muted-foreground">
              No decisions captured yet.
            </p>
          ) : (
            <div className="space-y-2">
              {decisions.map((decision) => {
                const actionable = decision.status === "pending" || decision.status === "awaiting_approval";
                const busy = approveMutation.isPending || rejectMutation.isPending;
                return (
                  <article key={decision.id} className="rounded-lg border border-border p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-foreground">{safeText(decision.actionKey)}</span>
                          <StatusBadge status={decision.status} />
                        </div>
                        <p className="text-xs text-muted-foreground">{safeText(decision.reason)}</p>
                      </div>
                      <div className="text-right text-xs text-muted-foreground">
                        <div>{formatDateTime(decision.createdAt)}</div>
                        <div className="mt-1">{safeText(decision.source)}</div>
                      </div>
                    </div>

                    <div className="mt-2 rounded-md bg-muted/40 px-2.5 py-2 text-xs text-muted-foreground">
                      {metricSummary(decision.metricName, decision.metricValue, decision.thresholdValue)}
                    </div>

                    <div className="mt-2 space-y-1 rounded-md border border-border bg-background/40 px-2.5 py-2 text-xs text-muted-foreground">
                      <div>
                        <span className="text-foreground">Trigger:</span>{" "}
                        {decision.metricName
                          ? `${decision.metricName} = ${formatNumericMetric(decision.metricValue)}${decision.thresholdValue == null ? "" : ` (threshold ${formatNumericMetric(decision.thresholdValue)})`}`
                          : "No metric evidence recorded"}
                      </div>
                      <div>
                        <span className="text-foreground">Action:</span>{" "}
                        {toActionLabel(decision.actionType, decision.actionKey)}
                      </div>
                      <div>
                        <span className="text-foreground">Why:</span>{" "}
                        {safeText(decision.reason)}
                      </div>
                    </div>

                    {decision.overrideNote && (
                      <p className="mt-2 text-xs text-muted-foreground">Override note: {decision.overrideNote}</p>
                    )}

                    {actionable && (
                      <div className="mt-3 flex items-center gap-2">
                        <Button
                          size="sm"
                          onClick={() => approveMutation.mutate(decision.id)}
                          disabled={busy}
                        >
                          <Check className="mr-1.5 h-3.5 w-3.5" />
                          Approve + Execute
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => rejectMutation.mutate(decision.id)}
                          disabled={busy}
                        >
                          <X className="mr-1.5 h-3.5 w-3.5" />
                          Reject
                        </Button>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </section>

        <section className="space-y-3 rounded-xl border border-border bg-card p-4">
          <header>
            <h2 className="text-sm font-semibold text-foreground">Core Overrides</h2>
            <p className="text-xs text-muted-foreground">Use agents and issues as manual override rails when autonomy is constrained.</p>
          </header>

          <Link
            to="/agents/all"
            className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm hover:bg-accent/50"
          >
            <span className="flex items-center gap-2">
              <Bot className="h-4 w-4 text-muted-foreground" />
              Agents
            </span>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </Link>

          <Link
            to="/issues"
            className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm hover:bg-accent/50"
          >
            <span className="flex items-center gap-2">
              <CircleDot className="h-4 w-4 text-muted-foreground" />
              Issues
            </span>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </Link>

          <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            Keep autonomy in <strong className="text-foreground">manual</strong> mode to queue decisions, review them here, then route execution through Agents and Issues.
          </div>
        </section>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <section className="space-y-3 rounded-xl border border-border bg-card p-4">
          <header className="flex items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-foreground">Cycle Visibility</h2>
              <p className="text-xs text-muted-foreground">Live state for traffic, email, decision, and execution loops.</p>
            </div>
            <TerminalSquare className="h-4 w-4 text-muted-foreground" />
          </header>

          {cycleStateQuery.isLoading ? (
            <PageSkeleton variant="list" />
          ) : (cycleStateQuery.data ?? []).length === 0 ? (
            <p className="rounded-md border border-dashed border-border px-3 py-5 text-sm text-muted-foreground">
              No cycle state rows yet.
            </p>
          ) : (
            <div className="space-y-2">
              {(cycleStateQuery.data ?? []).map((row) => (
                <article key={`${row.companyId}:${row.loopKey}`} className="rounded-lg border border-border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-sm font-medium text-foreground">{row.loopKey}</div>
                      <div className="text-xs text-muted-foreground">{row.stage ?? "idle"}</div>
                    </div>
                    <StatusBadge status={row.status} />
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                    <div>Action: {row.currentAction ?? "-"}</div>
                    <div>Duration: {formatDurationMs(row.lastRunDurationMs)}</div>
                    <div>Started: {formatDateTime(row.lastRunStartedAt)}</div>
                    <div>Completed: {formatDateTime(row.lastRunCompletedAt)}</div>
                  </div>
                  {row.lastError && (
                    <p className="mt-2 rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">
                      {row.lastError}
                    </p>
                  )}
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="space-y-3 rounded-xl border border-border bg-card p-4">
          <header className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-foreground">Live Execution Feed</h2>
              <p className="text-xs text-muted-foreground">Activity-log backed stream for traffic, email, decision, execution, and revenue events.</p>
            </div>
            <Waves className="h-4 w-4 text-muted-foreground" />
          </header>

          {feedSpamSummary.length > 0 ? (
            <div className="flex flex-wrap gap-2 text-xs">
              {feedSpamSummary.map((entry) => (
                <span key={entry.status} className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-muted-foreground">
                  {entry.status.toUpperCase()} x{entry.count}
                </span>
              ))}
            </div>
          ) : null}

          <div className="grid gap-2 sm:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor="feed-category">Category</Label>
              <Select value={feedCategoryFilter} onValueChange={setFeedCategoryFilter}>
                <SelectTrigger id="feed-category" className="w-full">
                  <SelectValue placeholder="All categories" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">all</SelectItem>
                  <SelectItem value="traffic">traffic</SelectItem>
                  <SelectItem value="email">email</SelectItem>
                  <SelectItem value="decision">decision</SelectItem>
                  <SelectItem value="execution">execution</SelectItem>
                  <SelectItem value="revenue">revenue</SelectItem>
                  <SelectItem value="system">system</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="feed-status">Status</Label>
              <Select value={feedStatusFilter} onValueChange={setFeedStatusFilter}>
                <SelectTrigger id="feed-status" className="w-full">
                  <SelectValue placeholder="All statuses" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">all</SelectItem>
                  <SelectItem value="info">info</SelectItem>
                  <SelectItem value="success">success</SelectItem>
                  <SelectItem value="failed">failed</SelectItem>
                  <SelectItem value="pending">pending</SelectItem>
                  <SelectItem value="blocked">blocked</SelectItem>
                  <SelectItem value="skipped">skipped</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-end justify-end text-xs text-muted-foreground">
              raw: {feedBuffer.length} · grouped: {groupedFeed.length}
            </div>
          </div>

          {executionFeedQuery.isLoading && groupedFeed.length === 0 ? (
            <PageSkeleton variant="list" />
          ) : groupedFeed.length === 0 ? (
            <p className="rounded-md border border-dashed border-border px-3 py-5 text-sm text-muted-foreground">
              No execution events for the selected filter.
            </p>
          ) : (
            <div className="max-h-[28rem] space-y-2 overflow-auto pr-1">
              {groupedFeed.map((group) => {
                const event = group.event;
                const trace = getTraceLink(event);
                const evidence = extractEvidence(event);
                const artifactMetrics = event.details.artifactMetrics && typeof event.details.artifactMetrics === "object"
                  ? event.details.artifactMetrics as { clicks?: number; conversions?: number; revenueCents?: number }
                  : null;
                return (
                <article key={event.id} className="rounded-lg border border-border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-sm font-medium text-foreground">{safeText(event.action)}</div>
                      <div className="text-xs text-muted-foreground">{toFeedRowLabel(event)}</div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {group.count > 1 ? <span className="text-xs text-muted-foreground">x{group.count}</span> : null}
                      <ExecutionStatusBadge status={event.status} />
                    </div>
                  </div>
                  {(event.status === "blocked" || event.status === "pending" || event.status === "skipped" || event.status === "failed") && (
                    <div className="mt-1 text-xs text-muted-foreground">
                      Reason: {group.reason ?? "Rule gate active"}
                    </div>
                  )}
                  <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                    <span>{safeText(event.category)}</span>
                    <span>{formatDateTime(event.createdAt)}</span>
                    {event.decisionId ? <span>decision: {event.decisionId.slice(0, 8)}</span> : null}
                    <span>trace: {trace.traceId.slice(0, 12)}</span>
                    {trace.issueId ? <span>issue: {trace.issueId.slice(0, 8)}</span> : null}
                    {trace.goalId ? <span>goal: {trace.goalId.slice(0, 8)}</span> : null}
                    {trace.agentId ? <span>agent: {trace.agentId.slice(0, 8)}</span> : null}
                    {artifactMetrics ? (
                      <span>
                        clicks {Math.max(0, Number(artifactMetrics.clicks ?? 0))}
                        {" · "}
                        conv {Math.max(0, Number(artifactMetrics.conversions ?? 0))}
                        {" · "}
                        rev ${((Math.max(0, Number(artifactMetrics.revenueCents ?? 0))) / 100).toFixed(2)}
                      </span>
                    ) : null}
                    {evidence?.url ? (
                      <a href={evidence.url} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                        output
                      </a>
                    ) : null}
                  </div>
                </article>
              );})}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
