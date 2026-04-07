import { useEffect, useMemo } from "react";
import { Link } from "@/lib/router";
import { useSearchParams } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";
import type { LiveRunForIssue } from "../api/heartbeats";
import { activityApi } from "../api/activity";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { cn, relativeTime } from "../lib/utils";
import { EmptyState } from "../components/EmptyState";
import { IssuesList } from "../components/IssuesList";
import { StatusBadge } from "../components/StatusBadge";
import { CircleDot } from "lucide-react";
import type { HeartbeatRun } from "@paperclipai/shared";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function extractIssueIdFromRun(run: HeartbeatRun): string | null {
  const snapshot = asRecord(run.contextSnapshot);
  if (!snapshot) return null;
  return asNonEmptyString(snapshot.issueId);
}

function extractRunOutput(run: HeartbeatRun): string {
  const result = asRecord(run.resultJson);
  const summary = asNonEmptyString(result?.summary) ?? asNonEmptyString(result?.result);
  if (summary) return summary;
  if (run.error) return run.error;
  if (run.stderrExcerpt) return run.stderrExcerpt;
  if (run.stdoutExcerpt) return run.stdoutExcerpt;
  return "-";
}

function invocationLabel(source: string) {
  if (source === "assignment") return "Builder";
  if (source === "automation") return "Research";
  if (source === "timer") return "Scheduler";
  if (source === "on_demand") return "Operator";
  return "System";
}

function truncateLine(text: string, max = 96) {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}...`;
}

function extractRunCostUsd(run: HeartbeatRun): number {
  const usage = asRecord(run.usageJson);
  const result = asRecord(run.resultJson);
  const candidates = [
    usage?.costUsd,
    usage?.cost_usd,
    usage?.total_cost_usd,
    result?.costUsd,
    result?.cost_usd,
    result?.total_cost_usd,
  ];
  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  }
  return 0;
}

function formatUsdCompact(valueUsd: number): string {
  if (valueUsd <= 0) return "$0.00";
  if (valueUsd < 1) return `$${valueUsd.toFixed(4)}`;
  return `$${valueUsd.toFixed(2)}`;
}

export function Issues() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(selectedCompanyId!),
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 2000,
  });

  const { data: recentRuns } = useQuery({
    queryKey: queryKeys.heartbeats(selectedCompanyId!, undefined),
    queryFn: () => heartbeatsApi.list(selectedCompanyId!, undefined, 400),
    enabled: !!selectedCompanyId,
    refetchInterval: 2000,
  });

  const { data: activity } = useQuery({
    queryKey: queryKeys.activity(selectedCompanyId!),
    queryFn: () => activityApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 2000,
  });

  const liveIssueIds = useMemo(() => {
    const ids = new Set<string>();
    for (const run of liveRuns ?? []) {
      if (run.issueId) ids.add(run.issueId);
    }
    return ids;
  }, [liveRuns]);

  useEffect(() => {
    setBreadcrumbs([{ label: "Issues" }]);
  }, [setBreadcrumbs]);

  const { data: issues, isLoading, error } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 2000,
  });

  const issueRuntimeRows = useMemo(() => {
    const issueList = issues ?? [];
    const runsByIssue = new Map<string, HeartbeatRun[]>();
    for (const run of recentRuns ?? []) {
      const issueId = extractIssueIdFromRun(run);
      if (!issueId) continue;
      const existing = runsByIssue.get(issueId);
      if (existing) {
        existing.push(run);
      } else {
        runsByIssue.set(issueId, [run]);
      }
    }
    for (const list of runsByIssue.values()) {
      list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    }

    const liveRunByIssue = new Map<string, LiveRunForIssue>();
    for (const run of liveRuns ?? []) {
      const issueId = run.issueId ?? null;
      if (!issueId) continue;
      if (!liveRunByIssue.has(issueId)) {
        liveRunByIssue.set(issueId, run);
      }
    }

    return issueList
      .map((issue) => {
        const runs = runsByIssue.get(issue.id) ?? [];
        const latestRun = runs[0] ?? null;
        const active = liveRunByIssue.get(issue.id) ?? null;
        const status = active ? "in_progress" : issue.status;
        const startedAt = active?.startedAt ?? latestRun?.startedAt ?? latestRun?.createdAt ?? issue.updatedAt;
        const totalCostUsd = runs.reduce((sum, run) => sum + extractRunCostUsd(run), 0);
        const lastRunCostUsd = latestRun ? extractRunCostUsd(latestRun) : 0;
        const assigneeName = issue.assigneeAgentId
          ? (agents ?? []).find((agent) => agent.id === issue.assigneeAgentId)?.name ?? issue.assigneeAgentId.slice(0, 8)
          : issue.assigneeUserId
            ? "Board"
            : "Unassigned";
        return {
          id: issue.id,
          identifier: issue.identifier ?? issue.id.slice(0, 8),
          title: issue.title,
          status,
          assigneeName,
          attempts: runs.length,
          startedAt,
          totalCostUsd,
          lastRunCostUsd,
          output: latestRun ? extractRunOutput(latestRun) : "-",
          isLive: Boolean(active),
        };
      })
      .sort((a, b) => {
        if (a.isLive && !b.isLive) return -1;
        if (!a.isLive && b.isLive) return 1;
        return new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime();
      });
  }, [issues, recentRuns, liveRuns, agents]);

  const activityFeed = useMemo(() => {
    const live = (liveRuns ?? []).map((run) => ({
      id: `live:${run.id}`,
      at: run.startedAt ?? run.createdAt,
      label: invocationLabel(run.invocationSource),
      detail: `${run.agentName} ${run.status === "running" ? "executing" : "queued"}`,
      meta: run.issueId ? `issue ${run.issueId.slice(0, 8)}` : "issue unknown",
      tone: run.status === "running" ? "text-cyan-400" : "text-yellow-400",
    }));

    const recent = (activity ?? [])
      .filter((event) =>
        event.action.startsWith("heartbeat.") ||
        event.action.startsWith("issue.") ||
        event.action.startsWith("governance."),
      )
      .slice(0, 40)
      .map((event) => ({
        id: event.id,
        at: event.createdAt,
        label: event.action,
        detail: `${event.entityType}:${event.entityId.slice(0, 8)}`,
        meta: `${event.actorType}:${event.actorId.slice(0, 8)}`,
        tone: event.action.includes("failed") || event.action.includes("blocked")
          ? "text-red-400"
          : "text-muted-foreground",
      }));

    return [...live, ...recent]
      .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
      .slice(0, 60);
  }, [activity, liveRuns]);

  const updateIssue = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      issuesApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId!) });
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={CircleDot} message="Select a company to view issues." />;
  }

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-border bg-card p-4">
        <header className="mb-3 flex items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold">Task Execution Table</h2>
            <p className="text-xs text-muted-foreground">Live refresh every 2 seconds</p>
          </div>
          <span className="text-xs text-muted-foreground">{issueRuntimeRows.length} tasks</span>
        </header>

        {isLoading && <p className="text-sm text-muted-foreground">Loading tasks...</p>}
        {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
        {!isLoading && !error && issueRuntimeRows.length === 0 && (
          <p className="text-sm text-muted-foreground">No tasks available.</p>
        )}

        {!isLoading && !error && issueRuntimeRows.length > 0 && (
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="min-w-full text-xs">
              <thead className="bg-muted/30 text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Task</th>
                  <th className="px-3 py-2 text-left font-medium">Status</th>
                  <th className="px-3 py-2 text-left font-medium">Agent</th>
                  <th className="px-3 py-2 text-left font-medium">Attempts</th>
                  <th className="px-3 py-2 text-left font-medium">Cost</th>
                  <th className="px-3 py-2 text-left font-medium">Started</th>
                  <th className="px-3 py-2 text-left font-medium">Output</th>
                </tr>
              </thead>
              <tbody>
                {issueRuntimeRows.map((row) => (
                  <tr key={row.id} className="border-t border-border hover:bg-accent/20">
                    <td className="px-3 py-2 align-top">
                      <Link to={`/issues/${row.identifier}`} className="font-medium hover:underline">
                        {row.identifier}
                      </Link>
                      <div className="mt-0.5 text-muted-foreground">{truncateLine(row.title, 84)}</div>
                    </td>
                    <td className="px-3 py-2 align-top">
                      <div className="flex items-center gap-2">
                        {row.isLive && <span className="h-2 w-2 rounded-full bg-cyan-500 animate-pulse" />}
                        <StatusBadge status={row.status} />
                      </div>
                    </td>
                    <td className="px-3 py-2 align-top text-muted-foreground">{row.assigneeName}</td>
                    <td className="px-3 py-2 align-top text-muted-foreground">{row.attempts}</td>
                    <td className="px-3 py-2 align-top text-muted-foreground">
                      <div className="font-medium text-foreground">{formatUsdCompact(row.totalCostUsd)}</div>
                      {row.lastRunCostUsd > 0 && (
                        <div className="text-[11px]">last run {formatUsdCompact(row.lastRunCostUsd)}</div>
                      )}
                    </td>
                    <td className="px-3 py-2 align-top text-muted-foreground">{relativeTime(row.startedAt)}</td>
                    <td className="px-3 py-2 align-top text-muted-foreground">{truncateLine(row.output, 110)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="rounded-lg border border-border bg-card p-4">
        <header className="mb-3 flex items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold">Live Activity Feed</h2>
            <p className="text-xs text-muted-foreground">Research, build, and execution activity (2s sync)</p>
          </div>
          <span className={cn("text-xs", activityFeed.length > 0 ? "text-cyan-500" : "text-muted-foreground")}>
            {activityFeed.length > 0 ? "streaming" : "idle"}
          </span>
        </header>

        {activityFeed.length === 0 ? (
          <p className="text-sm text-muted-foreground">No recent live activity.</p>
        ) : (
          <div className="max-h-72 space-y-1 overflow-y-auto rounded-md border border-border bg-neutral-950 p-2 font-mono text-xs text-neutral-100">
            {activityFeed.map((entry) => (
              <div key={entry.id} className="rounded border border-neutral-800 px-2 py-1">
                <div className="flex items-center justify-between gap-2">
                  <span className={entry.tone}>{entry.label}</span>
                  <span className="text-neutral-500">{relativeTime(entry.at)}</span>
                </div>
                <div className="text-neutral-300">{entry.detail}</div>
                <div className="text-neutral-500">{entry.meta}</div>
              </div>
            ))}
          </div>
        )}
      </section>

      <IssuesList
        issues={issues ?? []}
        isLoading={isLoading}
        error={error as Error | null}
        agents={agents}
        liveIssueIds={liveIssueIds}
        viewStateKey="paperclip:issues-view"
        initialAssignees={searchParams.get("assignee") ? [searchParams.get("assignee")!] : undefined}
        onUpdateIssue={(id, data) => updateIssue.mutate({ id, data })}
      />
    </div>
  );
}
