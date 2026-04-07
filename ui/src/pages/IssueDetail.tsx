import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { issuesApi, type IssueArtifact } from "../api/issues";
import { activityApi } from "../api/activity";
import { heartbeatsApi } from "../api/heartbeats";
import { agentsApi } from "../api/agents";
import { authApi } from "../api/auth";
import { projectsApi } from "../api/projects";
import { useCompany } from "../context/CompanyContext";
import { useToast } from "../context/ToastContext";
import { usePanel } from "../context/PanelContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { useProjectOrder } from "../hooks/useProjectOrder";
import { relativeTime, cn, formatTokens } from "../lib/utils";
import { InlineEditor } from "../components/InlineEditor";
import { CommentThread } from "../components/CommentThread";
import { IssueProperties } from "../components/IssueProperties";
import { LiveRunWidget } from "../components/LiveRunWidget";
import type { MentionOption } from "../components/MarkdownEditor";
import { StatusIcon } from "../components/StatusIcon";
import { PriorityIcon } from "../components/PriorityIcon";
import { StatusBadge } from "../components/StatusBadge";
import { Identity } from "../components/Identity";
import { Separator } from "@/components/ui/separator";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Activity as ActivityIcon,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  EyeOff,
  FileText,
  Files,
  Image,
  Hexagon,
  Hourglass,
  ListTree,
  MessageSquare,
  MoreHorizontal,
  Paperclip,
  RotateCcw,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import type { ActivityEvent } from "@paperclipai/shared";
import type { Agent, IssueAttachment } from "@paperclipai/shared";

type CommentReassignment = {
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
};

const ACTION_LABELS: Record<string, string> = {
  "issue.created": "created the issue",
  "issue.updated": "updated the issue",
  "issue.checked_out": "checked out the issue",
  "issue.released": "released the issue",
  "issue.comment_added": "added a comment",
  "issue.attachment_added": "added an attachment",
  "issue.attachment_removed": "removed an attachment",
  "issue.deleted": "deleted the issue",
  "agent.created": "created an agent",
  "agent.updated": "updated the agent",
  "agent.paused": "paused the agent",
  "agent.resumed": "resumed the agent",
  "agent.terminated": "terminated the agent",
  "heartbeat.invoked": "invoked a heartbeat",
  "heartbeat.cancelled": "cancelled a heartbeat",
  "approval.created": "requested approval",
  "approval.approved": "approved",
  "approval.rejected": "rejected",
};

function humanizeValue(value: unknown): string {
  if (typeof value !== "string") return String(value ?? "none");
  return value.replace(/_/g, " ");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function usageNumber(usage: Record<string, unknown> | null, ...keys: string[]) {
  if (!usage) return 0;
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "\u2026";
}

function extractReason(details: Record<string, unknown> | null | undefined): string | null {
  if (!details) return null;
  const candidates = [
    details.reason,
    details.error,
    details.errorMessage,
    details.message,
    details.detail,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate.trim();
  }
  return null;
}

function extractRunSummary(run: {
  status: string;
  usageJson: Record<string, unknown> | null;
  resultJson: Record<string, unknown> | null;
}): { summary: string; errorReason: string | null } {
  const result = asRecord(run.resultJson);
  const usage = asRecord(run.usageJson);
  const summary =
    (typeof result?.summary === "string" && result.summary.trim()) ||
    (typeof result?.result === "string" && result.result.trim()) ||
    (typeof result?.message === "string" && result.message.trim()) ||
    (typeof usage?.message === "string" && usage.message.trim()) ||
    "-";

  const errorReason =
    (typeof result?.error === "string" && result.error.trim()) ||
    (typeof result?.errorMessage === "string" && result.errorMessage.trim()) ||
    (typeof usage?.error === "string" && usage.error.trim()) ||
    null;

  return {
    summary,
    errorReason,
  };
}

function formatAction(action: string, details?: Record<string, unknown> | null): string {
  if (action === "issue.updated" && details) {
    const previous = (details._previous ?? {}) as Record<string, unknown>;
    const parts: string[] = [];

    if (details.status !== undefined) {
      const from = previous.status;
      parts.push(
        from
          ? `changed the status from ${humanizeValue(from)} to ${humanizeValue(details.status)}`
          : `changed the status to ${humanizeValue(details.status)}`
      );
    }
    if (details.priority !== undefined) {
      const from = previous.priority;
      parts.push(
        from
          ? `changed the priority from ${humanizeValue(from)} to ${humanizeValue(details.priority)}`
          : `changed the priority to ${humanizeValue(details.priority)}`
      );
    }
    if (details.assigneeAgentId !== undefined || details.assigneeUserId !== undefined) {
      parts.push(
        details.assigneeAgentId || details.assigneeUserId
          ? "assigned the issue"
          : "unassigned the issue",
      );
    }
    if (details.title !== undefined) parts.push("updated the title");
    if (details.description !== undefined) parts.push("updated the description");

    if (parts.length > 0) return parts.join(", ");
  }
  return ACTION_LABELS[action] ?? action.replace(/[._]/g, " ");
}

function ActorIdentity({ evt, agentMap }: { evt: ActivityEvent; agentMap: Map<string, Agent> }) {
  const id = evt.actorId;
  if (evt.actorType === "agent") {
    const agent = agentMap.get(id);
    return <Identity name={agent?.name ?? id.slice(0, 8)} size="sm" />;
  }
  if (evt.actorType === "system") return <Identity name="System" size="sm" />;
  if (evt.actorType === "user") return <Identity name="Board" size="sm" />;
  return <Identity name={id || "Unknown"} size="sm" />;
}

export function IssueDetail() {
  const { issueId } = useParams<{ issueId: string }>();
  const { selectedCompanyId } = useCompany();
  const { pushToast } = useToast();
  const { openPanel, closePanel, panelVisible, setPanelVisible } = usePanel();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [moreOpen, setMoreOpen] = useState(false);
  const [mobilePropsOpen, setMobilePropsOpen] = useState(false);
  const [detailTab, setDetailTab] = useState("comments");
  const [outputTab, setOutputTab] = useState("logs");
  const [selectedExecutionRunId, setSelectedExecutionRunId] = useState<string | null>(null);
  const [secondaryOpen, setSecondaryOpen] = useState({
    approvals: false,
    cost: false,
  });
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const { data: issue, isLoading, error } = useQuery({
    queryKey: queryKeys.issues.detail(issueId!),
    queryFn: () => issuesApi.get(issueId!),
    enabled: !!issueId,
  });

  const { data: comments } = useQuery({
    queryKey: queryKeys.issues.comments(issueId!),
    queryFn: () => issuesApi.listComments(issueId!),
    enabled: !!issueId,
  });

  const { data: activity } = useQuery({
    queryKey: queryKeys.issues.activity(issueId!),
    queryFn: () => activityApi.forIssue(issueId!),
    enabled: !!issueId,
    refetchInterval: 2000,
  });

  const { data: linkedRuns } = useQuery({
    queryKey: queryKeys.issues.runs(issueId!),
    queryFn: () => activityApi.runsForIssue(issueId!),
    enabled: !!issueId,
    refetchInterval: 2000,
  });

  const { data: linkedApprovals } = useQuery({
    queryKey: queryKeys.issues.approvals(issueId!),
    queryFn: () => issuesApi.listApprovals(issueId!),
    enabled: !!issueId,
  });

  const { data: attachments } = useQuery({
    queryKey: queryKeys.issues.attachments(issueId!),
    queryFn: () => issuesApi.listAttachments(issueId!),
    enabled: !!issueId,
  });

  const { data: artifacts } = useQuery({
    queryKey: queryKeys.issues.artifacts(issueId!),
    queryFn: () => issuesApi.listArtifacts(issueId!),
    enabled: !!issueId,
    refetchInterval: 2000,
  });

  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.issues.liveRuns(issueId!),
    queryFn: () => heartbeatsApi.liveRunsForIssue(issueId!),
    enabled: !!issueId,
    refetchInterval: 2000,
  });

  const { data: activeRun } = useQuery({
    queryKey: queryKeys.issues.activeRun(issueId!),
    queryFn: () => heartbeatsApi.activeRunForIssue(issueId!),
    enabled: !!issueId,
    refetchInterval: 2000,
  });

  const hasLiveRuns = (liveRuns ?? []).length > 0 || !!activeRun;

  const executionRuns = useMemo(() => {
    const rows = [...(linkedRuns ?? [])];
    if (activeRun && !rows.some((run) => run.runId === activeRun.id)) {
      rows.push({
        runId: activeRun.id,
        status: activeRun.status,
        agentId: activeRun.agentId,
        startedAt: activeRun.startedAt ? new Date(activeRun.startedAt).toISOString() : null,
        finishedAt: activeRun.finishedAt ? new Date(activeRun.finishedAt).toISOString() : null,
        createdAt: new Date(activeRun.createdAt).toISOString(),
        invocationSource: activeRun.invocationSource,
        usageJson: activeRun.usageJson,
        resultJson: activeRun.resultJson,
      });
    }
    return rows.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  }, [linkedRuns, activeRun]);

  useEffect(() => {
    if (executionRuns.length === 0) {
      setSelectedExecutionRunId(null);
      return;
    }
    if (selectedExecutionRunId && executionRuns.some((run) => run.runId === selectedExecutionRunId)) {
      return;
    }
    setSelectedExecutionRunId(executionRuns[executionRuns.length - 1]?.runId ?? null);
  }, [executionRuns, selectedExecutionRunId]);

  const selectedExecutionRun = useMemo(() => {
    if (!selectedExecutionRunId) return executionRuns[executionRuns.length - 1] ?? null;
    return executionRuns.find((run) => run.runId === selectedExecutionRunId) ?? executionRuns[executionRuns.length - 1] ?? null;
  }, [executionRuns, selectedExecutionRunId]);

  const runActivityMeta = useMemo(() => {
    const map = new Map<string, { reason: string | null; retryReason: string | null; attempts: number | null }>();
    for (const evt of activity ?? []) {
      if (!evt.runId) continue;
      const details = asRecord(evt.details);
      const action = evt.action.toLowerCase();
      const current = map.get(evt.runId) ?? { reason: null, retryReason: null, attempts: null };
      const reason = extractReason(details);

      if ((action.includes("failed") || action.includes("error") || action.includes("blocked")) && reason) {
        current.reason = reason;
      }

      if (action.includes("retry") && reason) {
        current.retryReason = reason;
      }

      const attemptRaw = details?.attempt ?? details?.attemptNumber ?? details?.retryCount;
      const attemptParsed = typeof attemptRaw === "number" ? attemptRaw : Number(attemptRaw);
      if (Number.isFinite(attemptParsed) && attemptParsed > 0) {
        current.attempts = Math.round(attemptParsed);
      }

      map.set(evt.runId, current);
    }
    return map;
  }, [activity]);

  const runAttempts = useMemo(() => {
    return executionRuns.map((run, index) => {
      const runMeta = runActivityMeta.get(run.runId);
      const summary = extractRunSummary(run);
      const reason = runMeta?.reason ?? summary.errorReason;
      const attempt = runMeta?.attempts ?? index + 1;
      return {
        run,
        attempt,
        reason,
      };
    });
  }, [executionRuns, runActivityMeta]);

  const { data: selectedRunLog } = useQuery({
    queryKey: ["issues", "run-log", selectedExecutionRun?.runId ?? "none"],
    queryFn: () => heartbeatsApi.log(selectedExecutionRun!.runId, 0, 320000),
    enabled: !!selectedExecutionRun,
    refetchInterval:
      selectedExecutionRun && (selectedExecutionRun.status === "running" || selectedExecutionRun.status === "queued")
        ? 2000
        : false,
  });

  // Filter out runs already shown by the live widget to avoid duplication
  const timelineRuns = useMemo(() => {
    const liveIds = new Set<string>();
    for (const r of liveRuns ?? []) liveIds.add(r.id);
    if (activeRun) liveIds.add(activeRun.id);
    if (liveIds.size === 0) return linkedRuns ?? [];
    return (linkedRuns ?? []).filter((r) => !liveIds.has(r.runId));
  }, [linkedRuns, liveRuns, activeRun]);

  const statusTimeline = useMemo(() => {
    const assignedEvent = (activity ?? []).find((evt) => {
      if (evt.action !== "issue.updated") return false;
      const details = evt.details as Record<string, unknown> | null;
      if (!details) return false;
      return details.assigneeAgentId !== undefined || details.assigneeUserId !== undefined;
    });
    const firstStartedRun = executionRuns.find((run) => run.startedAt);
    const isDone = issue?.status === "done" || issue?.status === "cancelled";

    return [
      { key: "created", label: "created", at: issue?.createdAt ?? null, state: "done" },
      {
        key: "assigned",
        label: "assigned",
        at: assignedEvent?.createdAt ?? null,
        state:
          issue?.assigneeAgentId || issue?.assigneeUserId || assignedEvent
            ? "done"
            : "pending",
      },
      {
        key: "in_progress",
        label: "in_progress",
        at: firstStartedRun?.startedAt ?? null,
        state:
          issue?.status === "in_progress"
            ? "active"
            : firstStartedRun || isDone
              ? "done"
              : "pending",
      },
      {
        key: "done",
        label: "done",
        at: isDone ? issue?.updatedAt ?? null : null,
        state: isDone ? "done" : "pending",
      },
    ] as const;
  }, [activity, executionRuns, issue]);

  const taskTimeline = useMemo(() => {
    const items: Array<{ id: string; at: string; label: string; detail: string; tone: "neutral" | "good" | "warn" | "bad" }> = [];

    if (issue?.createdAt) {
      items.push({
        id: `issue-created-${issue.id}`,
        at: new Date(issue.createdAt).toISOString(),
        label: "task created",
        detail: issue.identifier ?? issue.id.slice(0, 8),
        tone: "neutral",
      });
    }

    const assignedEvents = (activity ?? []).filter((evt) => {
      if (evt.action !== "issue.updated") return false;
      const details = asRecord(evt.details);
      return !!details && (details.assigneeAgentId !== undefined || details.assigneeUserId !== undefined);
    });

    for (const evt of assignedEvents) {
      const details = asRecord(evt.details);
      const target =
        (typeof details?.assigneeAgentId === "string" && details.assigneeAgentId) ||
        (typeof details?.assigneeUserId === "string" && details.assigneeUserId) ||
        "unassigned";
      items.push({
        id: `assign-${evt.id}`,
        at: new Date(evt.createdAt).toISOString(),
        label: "assigned",
        detail: target,
        tone: "neutral",
      });
    }

    executionRuns.forEach((run, index) => {
      const attempt = index + 1;
      const runMeta = runActivityMeta.get(run.runId);
      const summary = extractRunSummary(run);

      items.push({
        id: `run-created-${run.runId}`,
        at: run.createdAt,
        label: `attempt ${attempt} queued`,
        detail: run.invocationSource,
        tone: "neutral",
      });

      if (run.startedAt) {
        items.push({
          id: `run-start-${run.runId}`,
          at: run.startedAt,
          label: `attempt ${attempt} started`,
          detail: run.agentId.slice(0, 8),
          tone: "neutral",
        });
      }

      if (run.status === "failed") {
        items.push({
          id: `run-failed-${run.runId}`,
          at: run.finishedAt ?? run.createdAt,
          label: `attempt ${attempt} failed`,
          detail: runMeta?.reason ?? summary.errorReason ?? "execution failure",
          tone: "bad",
        });

        const nextRun = executionRuns[index + 1];
        if (nextRun) {
          items.push({
            id: `run-retry-${nextRun.runId}`,
            at: nextRun.createdAt,
            label: `retry ${attempt + 1}`,
            detail: runMeta?.retryReason ?? runMeta?.reason ?? summary.errorReason ?? "automatic retry",
            tone: "warn",
          });
        }
      }

      if (run.status === "completed" || run.status === "done") {
        items.push({
          id: `run-complete-${run.runId}`,
          at: run.finishedAt ?? run.createdAt,
          label: `attempt ${attempt} completed`,
          detail: summary.summary,
          tone: "good",
        });
      }
    });

    if (issue?.status === "done" || issue?.status === "cancelled") {
      items.push({
        id: `issue-finished-${issue.id}`,
        at: new Date(issue.updatedAt).toISOString(),
        label: issue.status === "done" ? "task completed" : "task cancelled",
        detail: issue.status,
        tone: issue.status === "done" ? "good" : "warn",
      });
    }

    return items.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  }, [activity, executionRuns, issue, runActivityMeta]);

  const outputArtifacts = useMemo(() => {
    const all = artifacts ?? [];
    const html = all.find((artifact) => artifact.kind === "html" && !!artifact.url) ?? null;
    const screenshot =
      all.find(
        (artifact) =>
          artifact.kind === "image" &&
          !!artifact.url &&
          /screen|screenshot|preview/i.test(artifact.title),
      ) ??
      all.find((artifact) => artifact.kind === "image" && !!artifact.url) ??
      null;
    const log = all.find((artifact) => artifact.kind === "log" && !!artifact.url) ?? null;
    const files = all.filter(
      (artifact) => artifact.id !== html?.id && artifact.id !== screenshot?.id && artifact.id !== log?.id,
    );
    return { html, screenshot, log, files };
  }, [artifacts]);

  const { data: allIssues } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  const { orderedProjects } = useProjectOrder({
    projects: projects ?? [],
    companyId: selectedCompanyId,
    userId: currentUserId,
  });

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);

  const mentionOptions = useMemo<MentionOption[]>(() => {
    const options: MentionOption[] = [];
    const activeAgents = [...(agents ?? [])]
      .filter((agent) => agent.status !== "terminated")
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const agent of activeAgents) {
      options.push({
        id: `agent:${agent.id}`,
        name: agent.name,
        kind: "agent",
      });
    }
    for (const project of orderedProjects) {
      options.push({
        id: `project:${project.id}`,
        name: project.name,
        kind: "project",
        projectId: project.id,
        projectColor: project.color,
      });
    }
    return options;
  }, [agents, orderedProjects]);

  const childIssues = useMemo(() => {
    if (!allIssues || !issue) return [];
    return allIssues
      .filter((i) => i.parentId === issue.id)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  }, [allIssues, issue]);

  const commentReassignOptions = useMemo(() => {
    const options: Array<{ id: string; label: string; searchText?: string }> = [];
    const activeAgents = [...(agents ?? [])]
      .filter((agent) => agent.status !== "terminated")
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const agent of activeAgents) {
      options.push({ id: `agent:${agent.id}`, label: agent.name });
    }
    if (currentUserId) {
      const label = currentUserId === "local-board" ? "Board" : "Me (Board)";
      options.push({ id: `user:${currentUserId}`, label });
    }
    return options;
  }, [agents, currentUserId]);

  const currentAssigneeValue = useMemo(() => {
    if (issue?.assigneeAgentId) return `agent:${issue.assigneeAgentId}`;
    if (issue?.assigneeUserId) return `user:${issue.assigneeUserId}`;
    return "";
  }, [issue?.assigneeAgentId, issue?.assigneeUserId]);

  const commentsWithRunMeta = useMemo(() => {
    const runMetaByCommentId = new Map<string, { runId: string; runAgentId: string | null }>();
    const agentIdByRunId = new Map<string, string>();
    for (const run of linkedRuns ?? []) {
      agentIdByRunId.set(run.runId, run.agentId);
    }
    for (const evt of activity ?? []) {
      if (evt.action !== "issue.comment_added" || !evt.runId) continue;
      const details = evt.details ?? {};
      const commentId = typeof details["commentId"] === "string" ? details["commentId"] : null;
      if (!commentId || runMetaByCommentId.has(commentId)) continue;
      runMetaByCommentId.set(commentId, {
        runId: evt.runId,
        runAgentId: evt.agentId ?? agentIdByRunId.get(evt.runId) ?? null,
      });
    }
    return (comments ?? []).map((comment) => {
      const meta = runMetaByCommentId.get(comment.id);
      return meta ? { ...comment, ...meta } : comment;
    });
  }, [activity, comments, linkedRuns]);

  const issueCostSummary = useMemo(() => {
    let input = 0;
    let output = 0;
    let cached = 0;
    let cost = 0;
    let hasCost = false;
    let hasTokens = false;

    for (const run of linkedRuns ?? []) {
      const usage = asRecord(run.usageJson);
      const result = asRecord(run.resultJson);
      const runInput = usageNumber(usage, "inputTokens", "input_tokens");
      const runOutput = usageNumber(usage, "outputTokens", "output_tokens");
      const runCached = usageNumber(
        usage,
        "cachedInputTokens",
        "cached_input_tokens",
        "cache_read_input_tokens",
      );
      const runCost =
        usageNumber(usage, "costUsd", "cost_usd", "total_cost_usd") ||
        usageNumber(result, "total_cost_usd", "cost_usd", "costUsd");
      if (runCost > 0) hasCost = true;
      if (runInput + runOutput + runCached > 0) hasTokens = true;
      input += runInput;
      output += runOutput;
      cached += runCached;
      cost += runCost;
    }

    return {
      input,
      output,
      cached,
      cost,
      totalTokens: input + output,
      hasCost,
      hasTokens,
    };
  }, [linkedRuns]);

  const invalidateIssue = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId!) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.activity(issueId!) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.runs(issueId!) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.approvals(issueId!) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.attachments(issueId!) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.artifacts(issueId!) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.liveRuns(issueId!) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.activeRun(issueId!) });
    if (selectedCompanyId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId) });
    }
  };

  const updateIssue = useMutation({
    mutationFn: (data: Record<string, unknown>) => issuesApi.update(issueId!, data),
    onSuccess: (updated) => {
      invalidateIssue();
      const issueRef = updated.identifier ?? `Issue ${updated.id.slice(0, 8)}`;
      pushToast({
        dedupeKey: `activity:issue.updated:${updated.id}`,
        title: `${issueRef} updated`,
        body: truncate(updated.title, 96),
        tone: "success",
        action: { label: `View ${issueRef}`, href: `/issues/${updated.identifier ?? updated.id}` },
      });
    },
  });

  const addComment = useMutation({
    mutationFn: ({ body, reopen }: { body: string; reopen?: boolean }) =>
      issuesApi.addComment(issueId!, body, reopen),
    onSuccess: (comment) => {
      invalidateIssue();
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(issueId!) });
      const issueRef = issue?.identifier ?? (issueId ? `Issue ${issueId.slice(0, 8)}` : "Issue");
      pushToast({
        dedupeKey: `activity:issue.comment_added:${issueId}:${comment.id}`,
        title: `Comment posted on ${issueRef}`,
        body: issue?.title ? truncate(issue.title, 96) : undefined,
        tone: "success",
        action: issueId ? { label: `View ${issueRef}`, href: `/issues/${issue?.identifier ?? issueId}` } : undefined,
      });
    },
  });

  const addCommentAndReassign = useMutation({
    mutationFn: ({
      body,
      reopen,
      reassignment,
    }: {
      body: string;
      reopen?: boolean;
      reassignment: CommentReassignment;
    }) =>
      issuesApi.update(issueId!, {
        comment: body,
        assigneeAgentId: reassignment.assigneeAgentId,
        assigneeUserId: reassignment.assigneeUserId,
        ...(reopen ? { status: "todo" } : {}),
      }),
    onSuccess: (updated) => {
      invalidateIssue();
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(issueId!) });
      const issueRef = updated.identifier ?? (issueId ? `Issue ${issueId.slice(0, 8)}` : "Issue");
      pushToast({
        dedupeKey: `activity:issue.reassigned:${updated.id}`,
        title: `${issueRef} reassigned`,
        body: issue?.title ? truncate(issue.title, 96) : undefined,
        tone: "success",
        action: issueId ? { label: `View ${issueRef}`, href: `/issues/${issue?.identifier ?? issueId}` } : undefined,
      });
    },
  });

  const uploadAttachment = useMutation({
    mutationFn: async (file: File) => {
      if (!selectedCompanyId) throw new Error("No company selected");
      return issuesApi.uploadAttachment(selectedCompanyId, issueId!, file);
    },
    onSuccess: () => {
      setAttachmentError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.attachments(issueId!) });
      invalidateIssue();
    },
    onError: (err) => {
      setAttachmentError(err instanceof Error ? err.message : "Upload failed");
    },
  });

  const deleteAttachment = useMutation({
    mutationFn: (attachmentId: string) => issuesApi.deleteAttachment(attachmentId),
    onSuccess: () => {
      setAttachmentError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.attachments(issueId!) });
      invalidateIssue();
    },
    onError: (err) => {
      setAttachmentError(err instanceof Error ? err.message : "Delete failed");
    },
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: "Issues", href: "/issues" },
      { label: issue?.title ?? issueId ?? "Issue" },
    ]);
  }, [setBreadcrumbs, issue, issueId]);

  // Redirect to identifier-based URL if navigated via UUID
  useEffect(() => {
    if (issue?.identifier && issueId !== issue.identifier) {
      navigate(`/issues/${issue.identifier}`, { replace: true });
    }
  }, [issue, issueId, navigate]);

  useEffect(() => {
    if (issue) {
      openPanel(
        <IssueProperties issue={issue} onUpdate={(data) => updateIssue.mutate(data)} />
      );
    }
    return () => closePanel();
  }, [issue]); // eslint-disable-line react-hooks/exhaustive-deps

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading...</p>;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;
  if (!issue) return null;

  // Ancestors are returned oldest-first from the server (root at end, immediate parent at start)
  const ancestors = issue.ancestors ?? [];

  const handleFilePicked = async (evt: ChangeEvent<HTMLInputElement>) => {
    const file = evt.target.files?.[0];
    if (!file) return;
    await uploadAttachment.mutateAsync(file);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const isImageAttachment = (attachment: IssueAttachment) => attachment.contentType.startsWith("image/");

  return (
    <div className="max-w-2xl space-y-6">
      {/* Parent chain breadcrumb */}
      {ancestors.length > 0 && (
        <nav className="flex items-center gap-1 text-xs text-muted-foreground flex-wrap">
          {[...ancestors].reverse().map((ancestor, i) => (
            <span key={ancestor.id} className="flex items-center gap-1">
              {i > 0 && <ChevronRight className="h-3 w-3 shrink-0" />}
              <Link
                to={`/issues/${ancestor.identifier ?? ancestor.id}`}
                className="hover:text-foreground transition-colors truncate max-w-[200px]"
                title={ancestor.title}
              >
                {ancestor.title}
              </Link>
            </span>
          ))}
          <ChevronRight className="h-3 w-3 shrink-0" />
          <span className="text-foreground/60 truncate max-w-[200px]">{issue.title}</span>
        </nav>
      )}

      {issue.hiddenAt && (
        <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <EyeOff className="h-4 w-4 shrink-0" />
          This issue is hidden
        </div>
      )}

      <div className="space-y-3">
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <StatusIcon
            status={issue.status}
            onChange={(status) => updateIssue.mutate({ status })}
          />
          <PriorityIcon
            priority={issue.priority}
            onChange={(priority) => updateIssue.mutate({ priority })}
          />
          <span className="text-sm font-mono text-muted-foreground shrink-0">{issue.identifier ?? issue.id.slice(0, 8)}</span>

          {hasLiveRuns && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-cyan-500/10 border border-cyan-500/30 px-2 py-0.5 text-[10px] font-medium text-cyan-600 dark:text-cyan-400 shrink-0">
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-cyan-400" />
              </span>
              Live
            </span>
          )}

          {issue.projectId ? (
            <Link
              to={`/projects/${issue.projectId}`}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors rounded px-1 -mx-1 py-0.5 min-w-0"
            >
              <Hexagon className="h-3 w-3 shrink-0" />
              <span className="truncate">{(projects ?? []).find((p) => p.id === issue.projectId)?.name ?? issue.projectId.slice(0, 8)}</span>
            </Link>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground opacity-50 px-1 -mx-1 py-0.5">
              <Hexagon className="h-3 w-3 shrink-0" />
              No project
            </span>
          )}

          {(issue.labels ?? []).length > 0 && (
            <div className="hidden sm:flex items-center gap-1">
              {(issue.labels ?? []).slice(0, 4).map((label) => (
                <span
                  key={label.id}
                  className="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium"
                  style={{
                    borderColor: label.color,
                    color: label.color,
                    backgroundColor: `${label.color}1f`,
                  }}
                >
                  {label.name}
                </span>
              ))}
              {(issue.labels ?? []).length > 4 && (
                <span className="text-[10px] text-muted-foreground">+{(issue.labels ?? []).length - 4}</span>
              )}
            </div>
          )}

          <Button
            variant="ghost"
            size="icon-xs"
            className="ml-auto md:hidden shrink-0"
            onClick={() => setMobilePropsOpen(true)}
            title="Properties"
          >
            <SlidersHorizontal className="h-4 w-4" />
          </Button>

          <div className="hidden md:flex items-center md:ml-auto shrink-0">
            <Button
              variant="ghost"
              size="icon-xs"
              className={cn(
                "shrink-0 transition-opacity duration-200",
                panelVisible ? "opacity-0 pointer-events-none w-0 overflow-hidden" : "opacity-100",
              )}
              onClick={() => setPanelVisible(true)}
              title="Show properties"
            >
              <SlidersHorizontal className="h-4 w-4" />
            </Button>

            <Popover open={moreOpen} onOpenChange={setMoreOpen}>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="icon-xs" className="shrink-0">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </PopoverTrigger>
            <PopoverContent className="w-44 p-1" align="end">
              <button
                className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 text-destructive"
                onClick={() => {
                  updateIssue.mutate(
                    { hiddenAt: new Date().toISOString() },
                    { onSuccess: () => navigate("/issues/all") },
                  );
                  setMoreOpen(false);
                }}
              >
                <EyeOff className="h-3 w-3" />
                Hide this Issue
              </button>
            </PopoverContent>
            </Popover>
          </div>
        </div>

        <InlineEditor
          value={issue.title}
          onSave={(title) => updateIssue.mutate({ title })}
          as="h2"
          className="text-xl font-bold"
        />

        <InlineEditor
          value={issue.description ?? ""}
          onSave={(description) => updateIssue.mutate({ description })}
          as="p"
          className="text-sm text-muted-foreground"
          placeholder="Add a description..."
          multiline
          mentions={mentionOptions}
          imageUploadHandler={async (file) => {
            const attachment = await uploadAttachment.mutateAsync(file);
            return attachment.contentPath;
          }}
        />
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium text-muted-foreground">Attachments</h3>
          <div className="flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="hidden"
              onChange={handleFilePicked}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadAttachment.isPending}
            >
              <Paperclip className="h-3.5 w-3.5 mr-1.5" />
              {uploadAttachment.isPending ? "Uploading..." : "Upload image"}
            </Button>
          </div>
        </div>

        {attachmentError && (
          <p className="text-xs text-destructive">{attachmentError}</p>
        )}

        {(!attachments || attachments.length === 0) ? (
          <p className="text-xs text-muted-foreground">No attachments yet.</p>
        ) : (
          <div className="space-y-2">
            {attachments.map((attachment) => (
              <div key={attachment.id} className="border border-border rounded-md p-2">
                <div className="flex items-center justify-between gap-2">
                  <a
                    href={attachment.contentPath}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs hover:underline truncate"
                    title={attachment.originalFilename ?? attachment.id}
                  >
                    {attachment.originalFilename ?? attachment.id}
                  </a>
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => deleteAttachment.mutate(attachment.id)}
                    disabled={deleteAttachment.isPending}
                    title="Delete attachment"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {attachment.contentType} · {(attachment.byteSize / 1024).toFixed(1)} KB
                </p>
                {isImageAttachment(attachment) && (
                  <a href={attachment.contentPath} target="_blank" rel="noreferrer">
                    <img
                      src={attachment.contentPath}
                      alt={attachment.originalFilename ?? "attachment"}
                      className="mt-2 max-h-56 rounded border border-border object-contain bg-accent/10"
                      loading="lazy"
                    />
                  </a>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <Separator />

      <Tabs value={detailTab} onValueChange={setDetailTab} className="space-y-3">
        <TabsList variant="line" className="w-full justify-start gap-1">
          <TabsTrigger value="comments" className="gap-1.5">
            <MessageSquare className="h-3.5 w-3.5" />
            Comments
          </TabsTrigger>
          <TabsTrigger value="execution" className="gap-1.5">
            <ActivityIcon className="h-3.5 w-3.5" />
            Execution
          </TabsTrigger>
          <TabsTrigger value="subissues" className="gap-1.5">
            <ListTree className="h-3.5 w-3.5" />
            Sub-issues
          </TabsTrigger>
          <TabsTrigger value="activity" className="gap-1.5">
            <ActivityIcon className="h-3.5 w-3.5" />
            Activity
          </TabsTrigger>
        </TabsList>

        <TabsContent value="comments">
          <CommentThread
            comments={commentsWithRunMeta}
            linkedRuns={timelineRuns}
            issueStatus={issue.status}
            agentMap={agentMap}
            draftKey={`paperclip:issue-comment-draft:${issue.id}`}
            enableReassign
            reassignOptions={commentReassignOptions}
            currentAssigneeValue={currentAssigneeValue}
            mentions={mentionOptions}
            onAdd={async (body, reopen, reassignment) => {
              if (reassignment) {
                await addCommentAndReassign.mutateAsync({ body, reopen, reassignment });
                return;
              }
              await addComment.mutateAsync({ body, reopen });
            }}
            imageUploadHandler={async (file) => {
              const attachment = await uploadAttachment.mutateAsync(file);
              return attachment.contentPath;
            }}
            onAttachImage={async (file) => {
              await uploadAttachment.mutateAsync(file);
            }}
            liveRunSlot={<LiveRunWidget issueId={issueId!} companyId={issue.companyId} />}
          />
        </TabsContent>

        <TabsContent value="execution" className="space-y-4">
          <div className="rounded-md border border-border bg-muted/20 p-3">
            <h4 className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">Execution Progress</h4>
            <div className="grid gap-2 sm:grid-cols-4">
              {statusTimeline.map((node) => (
                <div key={node.key} className="rounded border border-border/70 bg-background p-2">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        "h-2 w-2 rounded-full",
                        node.state === "done"
                          ? "bg-green-500"
                          : node.state === "active"
                            ? "bg-cyan-500 animate-pulse"
                            : "bg-muted",
                      )}
                    />
                    <span className="text-xs font-medium">{node.label.replace(/_/g, " ")}</span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{node.at ? relativeTime(node.at) : "pending"}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="grid gap-3 xl:grid-cols-[1.4fr_1fr]">
            <div className="space-y-3 rounded-md border border-border p-3">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Retry Attempts</h4>
                <span className="text-[11px] text-muted-foreground">{runAttempts.length} total</span>
              </div>
              {runAttempts.length === 0 ? (
                <p className="text-sm text-muted-foreground">No runs yet.</p>
              ) : (
                <div className="grid gap-2 md:grid-cols-2">
                  {runAttempts.map(({ run, attempt, reason }) => {
                    const summary = extractRunSummary(run);
                    const isSelected = selectedExecutionRun?.runId === run.runId;
                    const isFailure = run.status === "failed";
                    return (
                      <button
                        key={run.runId}
                        type="button"
                        onClick={() => setSelectedExecutionRunId(run.runId)}
                        className={cn(
                          "rounded border px-3 py-2 text-left transition-colors",
                          isSelected ? "border-cyan-500/60 bg-cyan-500/10" : "border-border hover:bg-accent/20",
                        )}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            {isFailure ? (
                              <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                            ) : (
                              <RotateCcw className="h-3.5 w-3.5 text-muted-foreground" />
                            )}
                            <span className="text-xs font-medium">Attempt {attempt}</span>
                          </div>
                          <StatusBadge status={run.status} />
                        </div>
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          {run.startedAt ? relativeTime(run.startedAt) : relativeTime(run.createdAt)}
                        </p>
                        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                          {reason ?? summary.summary}
                        </p>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="rounded-md border border-border p-3">
              <h4 className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">Task Timeline</h4>
              {taskTimeline.length === 0 ? (
                <p className="text-sm text-muted-foreground">No timeline events yet.</p>
              ) : (
                <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
                  {taskTimeline.map((item) => (
                    <div key={item.id} className="flex items-start gap-2 rounded border border-border/70 bg-muted/20 p-2">
                      <Hourglass
                        className={cn(
                          "mt-0.5 h-3.5 w-3.5",
                          item.tone === "good"
                            ? "text-green-500"
                            : item.tone === "bad"
                              ? "text-red-500"
                              : item.tone === "warn"
                                ? "text-amber-500"
                                : "text-muted-foreground",
                        )}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="text-xs font-medium">{item.label}</p>
                          <span className="text-[11px] text-muted-foreground">{relativeTime(item.at)}</span>
                        </div>
                        <p className="truncate text-[11px] text-muted-foreground" title={item.detail}>{item.detail}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="rounded-md border border-border p-3">
            <div className="mb-3 flex items-center justify-between">
              <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Output Viewer</h4>
              {selectedExecutionRun && (
                <span className="text-[11px] text-muted-foreground">
                  Run {selectedExecutionRun.runId.slice(0, 8)}
                </span>
              )}
            </div>
            <Tabs value={outputTab} onValueChange={setOutputTab}>
              <TabsList variant="line" className="mb-3 w-full justify-start gap-1">
                <TabsTrigger value="logs" className="gap-1.5">
                  <FileText className="h-3.5 w-3.5" />
                  Logs
                </TabsTrigger>
                <TabsTrigger value="html" className="gap-1.5">
                  <Files className="h-3.5 w-3.5" />
                  HTML Preview
                </TabsTrigger>
                <TabsTrigger value="screenshot" className="gap-1.5">
                  <Image className="h-3.5 w-3.5" />
                  Screenshot
                </TabsTrigger>
                <TabsTrigger value="files" className="gap-1.5">
                  <Paperclip className="h-3.5 w-3.5" />
                  Files
                </TabsTrigger>
              </TabsList>

              <TabsContent value="logs" className="space-y-2">
                {!selectedRunLog?.content && outputArtifacts.log?.url && (
                  <a
                    href={outputArtifacts.log.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex text-xs text-cyan-600 hover:underline"
                  >
                    Open persisted log artifact
                  </a>
                )}
                <pre className="max-h-80 overflow-y-auto rounded bg-neutral-950 p-3 font-mono text-xs text-neutral-100">
                  {selectedRunLog?.content ?? "Select a run to inspect stdout/stderr logs."}
                </pre>
              </TabsContent>

              <TabsContent value="html" className="space-y-2">
                {!outputArtifacts.html?.url ? (
                  <p className="text-sm text-muted-foreground">No HTML preview artifact found.</p>
                ) : (
                  <>
                    <a
                      href={outputArtifacts.html.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex text-xs text-cyan-600 hover:underline"
                    >
                      Open HTML in new tab
                    </a>
                    <iframe
                      src={outputArtifacts.html.url}
                      title={outputArtifacts.html.title || "HTML Preview"}
                      className="h-[26rem] w-full rounded border border-border/70 bg-background"
                    />
                  </>
                )}
              </TabsContent>

              <TabsContent value="screenshot" className="space-y-2">
                {!outputArtifacts.screenshot?.url ? (
                  <p className="text-sm text-muted-foreground">No screenshot artifact found.</p>
                ) : (
                  <a href={outputArtifacts.screenshot.url} target="_blank" rel="noreferrer">
                    <img
                      src={outputArtifacts.screenshot.url}
                      alt={outputArtifacts.screenshot.title || "Execution screenshot"}
                      className="max-h-[34rem] w-full rounded border border-border/70 object-contain bg-accent/20"
                      loading="lazy"
                    />
                  </a>
                )}
              </TabsContent>

              <TabsContent value="files" className="space-y-2">
                {outputArtifacts.files.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No additional files found for this task.</p>
                ) : (
                  <div className="max-h-80 space-y-3 overflow-y-auto pr-1">
                    {outputArtifacts.files.map((artifact) => (
                      <ExecutionArtifactCard key={artifact.id} artifact={artifact} />
                    ))}
                  </div>
                )}
              </TabsContent>
            </Tabs>
          </div>
        </TabsContent>

        <TabsContent value="subissues">
          {childIssues.length === 0 ? (
            <p className="text-xs text-muted-foreground">No sub-issues.</p>
          ) : (
            <div className="border border-border rounded-lg divide-y divide-border">
              {childIssues.map((child) => (
                <Link
                  key={child.id}
                  to={`/issues/${child.identifier ?? child.id}`}
                  className="flex items-center justify-between px-3 py-2 text-sm hover:bg-accent/20 transition-colors"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <StatusIcon status={child.status} />
                    <PriorityIcon priority={child.priority} />
                    <span className="font-mono text-muted-foreground shrink-0">
                      {child.identifier ?? child.id.slice(0, 8)}
                    </span>
                    <span className="truncate">{child.title}</span>
                  </div>
                  {child.assigneeAgentId && (() => {
                    const name = agentMap.get(child.assigneeAgentId)?.name;
                    return name
                      ? <Identity name={name} size="sm" />
                      : <span className="text-muted-foreground font-mono">{child.assigneeAgentId.slice(0, 8)}</span>;
                  })()}
                </Link>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="activity">
          {!activity || activity.length === 0 ? (
            <p className="text-xs text-muted-foreground">No activity yet.</p>
          ) : (
            <div className="space-y-1.5">
              {activity.slice(0, 20).map((evt) => (
                <div key={evt.id} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <ActorIdentity evt={evt} agentMap={agentMap} />
                  <span>{formatAction(evt.action, evt.details)}</span>
                  <span className="ml-auto shrink-0">{relativeTime(evt.createdAt)}</span>
                </div>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>

      {linkedApprovals && linkedApprovals.length > 0 && (
        <Collapsible
          open={secondaryOpen.approvals}
          onOpenChange={(open) => setSecondaryOpen((prev) => ({ ...prev, approvals: open }))}
          className="rounded-lg border border-border"
        >
          <CollapsibleTrigger className="flex w-full items-center justify-between px-3 py-2 text-left">
            <span className="text-sm font-medium text-muted-foreground">
              Linked Approvals ({linkedApprovals.length})
            </span>
            <ChevronDown
              className={cn("h-4 w-4 text-muted-foreground transition-transform", secondaryOpen.approvals && "rotate-180")}
            />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="border-t border-border divide-y divide-border">
              {linkedApprovals.map((approval) => (
                <Link
                  key={approval.id}
                  to={`/approvals/${approval.id}`}
                  className="flex items-center justify-between px-3 py-2 text-xs hover:bg-accent/20 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <StatusBadge status={approval.status} />
                    <span className="font-medium">
                      {approval.type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}
                    </span>
                    <span className="font-mono text-muted-foreground">{approval.id.slice(0, 8)}</span>
                  </div>
                  <span className="text-muted-foreground">{relativeTime(approval.createdAt)}</span>
                </Link>
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}

      {linkedRuns && linkedRuns.length > 0 && (
        <Collapsible
          open={secondaryOpen.cost}
          onOpenChange={(open) => setSecondaryOpen((prev) => ({ ...prev, cost: open }))}
          className="rounded-lg border border-border"
        >
          <CollapsibleTrigger className="flex w-full items-center justify-between px-3 py-2 text-left">
            <span className="text-sm font-medium text-muted-foreground">Cost Summary</span>
            <ChevronDown
              className={cn("h-4 w-4 text-muted-foreground transition-transform", secondaryOpen.cost && "rotate-180")}
            />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="border-t border-border px-3 py-2">
              {!issueCostSummary.hasCost && !issueCostSummary.hasTokens ? (
                <div className="text-xs text-muted-foreground">No cost data yet.</div>
              ) : (
                <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                  {issueCostSummary.hasCost && (
                    <span className="font-medium text-foreground">
                      ${issueCostSummary.cost.toFixed(4)}
                    </span>
                  )}
                  {issueCostSummary.hasTokens && (
                    <span>
                      Tokens {formatTokens(issueCostSummary.totalTokens)}
                      {issueCostSummary.cached > 0
                        ? ` (in ${formatTokens(issueCostSummary.input)}, out ${formatTokens(issueCostSummary.output)}, cached ${formatTokens(issueCostSummary.cached)})`
                        : ` (in ${formatTokens(issueCostSummary.input)}, out ${formatTokens(issueCostSummary.output)})`}
                    </span>
                  )}
                </div>
              )}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* Mobile properties drawer */}
      <Sheet open={mobilePropsOpen} onOpenChange={setMobilePropsOpen}>
        <SheetContent side="bottom" className="max-h-[85dvh] pb-[env(safe-area-inset-bottom)]">
          <SheetHeader>
            <SheetTitle className="text-sm">Properties</SheetTitle>
          </SheetHeader>
          <ScrollArea className="flex-1 overflow-y-auto">
            <div className="px-4 pb-4">
              <IssueProperties issue={issue} onUpdate={(data) => updateIssue.mutate(data)} inline />
            </div>
          </ScrollArea>
        </SheetContent>
      </Sheet>
    </div>
  );
}

function ExecutionArtifactCard({ artifact }: { artifact: IssueArtifact }) {
  const canPreviewHtml = artifact.kind === "html" && !!artifact.url;
  const canPreviewImage = artifact.kind === "image" && !!artifact.url;

  return (
    <div className="rounded border border-border/70 p-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{artifact.title}</span>
        <span className="text-muted-foreground">{artifact.source}</span>
      </div>

      <div className="mt-1 text-muted-foreground">
        {artifact.runId ? `run ${artifact.runId.slice(0, 8)} · ` : ""}
        {relativeTime(artifact.createdAt)}
      </div>

      {artifact.url && (
        <a
          href={artifact.url}
          target="_blank"
          rel="noreferrer"
          className="mt-1 inline-flex text-cyan-600 hover:underline"
        >
          Open artifact
        </a>
      )}

      {canPreviewImage && (
        <img
          src={artifact.url!}
          alt={artifact.title}
          className="mt-2 max-h-44 rounded border border-border object-contain"
          loading="lazy"
        />
      )}

      {canPreviewHtml && (
        <iframe
          src={artifact.url!}
          title={artifact.title}
          className="mt-2 h-44 w-full rounded border border-border bg-background"
        />
      )}
    </div>
  );
}
