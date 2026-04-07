import { useEffect, useMemo } from "react";
import { useParams } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { goalsApi } from "../api/goals";
import { aiDashboardApi } from "../api/ai-dashboard";
import { activityApi } from "../api/activity";
import { projectsApi } from "../api/projects";
import { assetsApi } from "../api/assets";
import { ApiError } from "../api/client";
import { usePanel } from "../context/PanelContext";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { timeAgo } from "../lib/timeAgo";
import { GoalProperties } from "../components/GoalProperties";
import { GoalTree } from "../components/GoalTree";
import { StatusBadge } from "../components/StatusBadge";
import { InlineEditor } from "../components/InlineEditor";
import { EntityRow } from "../components/EntityRow";
import { PageSkeleton } from "../components/PageSkeleton";
import { projectUrl } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Clock3, Plus, Radio } from "lucide-react";
import type { Goal, Project } from "@paperclipai/shared";

function numeric(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function normalizeRunTime(run: { startedAt: string | null; finishedAt: string | null }): number {
  if (!run.startedAt || !run.finishedAt) return 0;
  const start = new Date(run.startedAt).getTime();
  const end = new Date(run.finishedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return Math.round((end - start) / 1000);
}

export function GoalDetail() {
  const { goalId } = useParams<{ goalId: string }>();
  const { selectedCompanyId, setSelectedCompanyId } = useCompany();
  const { openNewGoal } = useDialog();
  const { openPanel, closePanel } = usePanel();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  const goalQuery = useQuery({
    queryKey: queryKeys.goals.detail(goalId!),
    queryFn: () => goalsApi.get(goalId!),
    enabled: !!goalId,
    retry: false,
  });

  const goal = goalQuery.data;
  const isAiPlanRoute = goalQuery.error instanceof ApiError && goalQuery.error.status === 404;
  const resolvedCompanyId = goal?.companyId ?? selectedCompanyId;

  const aiGoalMemoryQuery = useQuery({
    queryKey:
      resolvedCompanyId && goalId
        ? queryKeys.aiGoalMemory(resolvedCompanyId, goalId)
        : ["goal-memory", "none"],
    queryFn: () => aiDashboardApi.goalMemory(resolvedCompanyId!, goalId!),
    enabled: !!resolvedCompanyId && !!goalId && isAiPlanRoute,
    retry: false,
    refetchInterval: 2_000,
  });

  const aiGoalRunsQuery = useQuery({
    queryKey:
      aiGoalMemoryQuery.data?.issueId
        ? queryKeys.issues.runs(aiGoalMemoryQuery.data.issueId)
        : ["issues", "runs", "none"],
    queryFn: () => activityApi.runsForIssue(aiGoalMemoryQuery.data!.issueId!),
    enabled: !!aiGoalMemoryQuery.data?.issueId,
    refetchInterval: 2_000,
  });

  const { data: allGoals } = useQuery({
    queryKey: queryKeys.goals.list(resolvedCompanyId!),
    queryFn: () => goalsApi.list(resolvedCompanyId!),
    enabled: !!resolvedCompanyId && !isAiPlanRoute,
  });

  const { data: allProjects } = useQuery({
    queryKey: queryKeys.projects.list(resolvedCompanyId!),
    queryFn: () => projectsApi.list(resolvedCompanyId!),
    enabled: !!resolvedCompanyId && !isAiPlanRoute,
  });

  useEffect(() => {
    if (!goal?.companyId || goal.companyId === selectedCompanyId) return;
    setSelectedCompanyId(goal.companyId, { source: "route_sync" });
  }, [goal?.companyId, selectedCompanyId, setSelectedCompanyId]);

  const updateGoal = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      goalsApi.update(goalId!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.goals.detail(goalId!)
      });
      if (resolvedCompanyId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.goals.list(resolvedCompanyId)
        });
      }
    }
  });

  const uploadImage = useMutation({
    mutationFn: async (file: File) => {
      if (!resolvedCompanyId) throw new Error("No company selected");
      return assetsApi.uploadImage(
        resolvedCompanyId,
        file,
        `goals/${goalId ?? "draft"}`
      );
    }
  });

  const childGoals = (allGoals ?? []).filter((g) => g.parentId === goalId);
  const linkedProjects = (allProjects ?? []).filter((p) => {
    if (!goalId) return false;
    if (p.goalIds.includes(goalId)) return true;
    if (p.goals.some((goalRef) => goalRef.id === goalId)) return true;
    return p.goalId === goalId;
  });

  const aiSteps = aiGoalMemoryQuery.data?.steps ?? [];
  const aiProgress = useMemo(() => {
    const total = aiSteps.length;
    const completed = aiSteps.filter((step) => step.status === "completed").length;
    const running = aiSteps.filter((step) => step.status === "running").length;
    const pending = aiSteps.filter((step) => step.status === "pending").length;
    const failed = aiSteps.filter((step) => step.status === "failed").length;
    const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
    return { total, completed, running, pending, failed, percent };
  }, [aiSteps]);

  const aiPrediction = useMemo(() => {
    const completed = new Set(
      aiSteps.filter((step) => step.status === "completed").map((step) => step.id),
    );
    const ready = aiSteps.filter(
      (step) =>
        step.status === "pending" &&
        (step.dependsOn ?? []).every((depId) => completed.has(depId)),
    );
    const running = aiSteps.find((step) => step.status === "running") ?? null;
    const next = running?.name ?? ready[0]?.name ?? "No executable step";

    const durations = (aiGoalRunsQuery.data ?? [])
      .map((run) => normalizeRunTime(run))
      .filter((seconds) => seconds > 0);
    const avgSec = durations.length > 0
      ? durations.reduce((sum, seconds) => sum + seconds, 0) / durations.length
      : 90;
    const remaining = aiSteps.filter(
      (step) => step.status === "pending" || step.status === "running",
    ).length;
    const etaSec = Math.max(30, Math.round(Math.max(1, remaining) * avgSec));
    const eta = etaSec < 60 ? `${etaSec}s` : `${Math.max(1, Math.round(etaSec / 60))}m`;

    const nearRetryLimit = aiSteps.filter((step) => {
      const retries = numeric(step.retries, 0);
      const maxRetries = Math.max(1, numeric(step.maxRetries, 1));
      return retries >= maxRetries - 1;
    }).length;
    const failures = aiSteps.filter((step) => step.status === "failed").length;
    const riskScore = failures * 2 + nearRetryLimit * 2;
    const risk = riskScore >= 6 ? "high" : riskScore >= 3 ? "medium" : "low";

    return { next, eta, risk, failures, nearRetryLimit };
  }, [aiGoalRunsQuery.data, aiSteps]);

  useEffect(() => {
    setBreadcrumbs([
      { label: "Goals", href: "/goals" },
      { label: goal?.title ?? (isAiPlanRoute ? `AI Goal ${goalId?.slice(0, 8)}` : goalId ?? "Goal") }
    ]);
  }, [setBreadcrumbs, goal, goalId, isAiPlanRoute]);

  useEffect(() => {
    if (goal && !isAiPlanRoute) {
      openPanel(
        <GoalProperties
          goal={goal}
          onUpdate={(data) => updateGoal.mutate(data)}
        />
      );
    }
    return () => closePanel();
  }, [goal, isAiPlanRoute]); // eslint-disable-line react-hooks/exhaustive-deps

  if (goalQuery.isLoading && !isAiPlanRoute) return <PageSkeleton variant="detail" />;
  if (goalQuery.error && !isAiPlanRoute) {
    return <p className="text-sm text-destructive">{goalQuery.error.message}</p>;
  }

  if (isAiPlanRoute) {
    if (!resolvedCompanyId) {
      return <p className="text-sm text-muted-foreground">Select a company to inspect this AI goal.</p>;
    }

    if (aiGoalMemoryQuery.isLoading) return <PageSkeleton variant="detail" />;
    if (aiGoalMemoryQuery.error) {
      return (
        <p className="text-sm text-destructive">
          {aiGoalMemoryQuery.error.message}
        </p>
      );
    }

    if (!aiGoalMemoryQuery.data) {
      return <p className="text-sm text-muted-foreground">No orchestration data found for this goal id.</p>;
    }

    const aiGoal = aiGoalMemoryQuery.data;

    return (
      <div className="space-y-6">
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-xs uppercase text-muted-foreground">ai plan</span>
            <StatusBadge status={aiGoal.status} />
          </div>
          <h2 className="text-xl font-bold">{aiGoal.goal}</h2>
          <p className="text-sm text-muted-foreground">
            Plan {aiGoal.planId.slice(0, 8)} · Agent {aiGoal.agentId.slice(0, 8)} · Iterations {aiGoal.iterationsUsed}/{aiGoal.maxIterations}
          </p>
        </div>

        <div className="grid gap-2 md:grid-cols-4">
          <div className="rounded-md border border-border bg-muted/20 p-3">
            <div className="text-xs text-muted-foreground">Progress</div>
            <div className="mt-1 text-sm font-semibold">{aiProgress.percent}%</div>
            <div className="text-xs text-muted-foreground">{aiProgress.completed}/{aiProgress.total} completed</div>
          </div>
          <div className="rounded-md border border-border bg-muted/20 p-3">
            <div className="text-xs text-muted-foreground">Next Step</div>
            <div className="mt-1 text-sm font-semibold">{aiPrediction.next}</div>
            <div className="text-xs text-muted-foreground">planner-selected next action</div>
          </div>
          <div className="rounded-md border border-border bg-muted/20 p-3">
            <div className="text-xs text-muted-foreground">ETA</div>
            <div className="mt-1 flex items-center gap-2 text-sm font-semibold">
              <Clock3 className="h-4 w-4 text-muted-foreground" />
              {aiPrediction.eta}
            </div>
            <div className="text-xs text-muted-foreground">estimated remaining execution</div>
          </div>
          <div className="rounded-md border border-border bg-muted/20 p-3">
            <div className="text-xs text-muted-foreground">Risk</div>
            <div className="mt-1 flex items-center gap-2 text-sm font-semibold capitalize">
              <Radio
                className={
                  aiPrediction.risk === "high"
                    ? "h-4 w-4 text-red-500"
                    : aiPrediction.risk === "medium"
                      ? "h-4 w-4 text-amber-500"
                      : "h-4 w-4 text-green-600"
                }
              />
              {aiPrediction.risk}
            </div>
            <div className="text-xs text-muted-foreground">
              {aiPrediction.failures} failed · {aiPrediction.nearRetryLimit} near retry limit
            </div>
          </div>
        </div>

        <div className="overflow-x-auto rounded-md border border-border">
          <table className="min-w-full text-xs">
            <thead className="bg-muted/30 text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Step</th>
                <th className="px-3 py-2 text-left font-medium">Status</th>
                <th className="px-3 py-2 text-left font-medium">Depends On</th>
                <th className="px-3 py-2 text-left font-medium">Attempts</th>
                <th className="px-3 py-2 text-left font-medium">Tool</th>
              </tr>
            </thead>
            <tbody>
              {aiGoal.steps.map((step) => (
                <tr key={step.id} className="border-t border-border">
                  <td className="px-3 py-2 align-top font-medium">{step.name}</td>
                  <td className="px-3 py-2 align-top"><StatusBadge status={step.status} /></td>
                  <td className="px-3 py-2 align-top text-muted-foreground">
                    {(step.dependsOn ?? []).length > 0 ? (step.dependsOn ?? []).join(", ") : "-"}
                  </td>
                  <td className="px-3 py-2 align-top text-muted-foreground">
                    {numeric(step.retries, 0) + (step.status === "pending" ? 0 : 1)}/{numeric(step.maxRetries, 0)}
                  </td>
                  <td className="px-3 py-2 align-top text-muted-foreground">{step.toolName ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="rounded-md border border-border p-3">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Recent Runs</h3>
          {(aiGoalRunsQuery.data ?? []).length === 0 && (
            <p className="mt-2 text-sm text-muted-foreground">No runs logged for this goal issue yet.</p>
          )}
          {(aiGoalRunsQuery.data ?? []).length > 0 && (
            <div className="mt-2 space-y-1 text-xs">
              {(aiGoalRunsQuery.data ?? []).slice(0, 8).map((run) => (
                <div key={run.runId} className="flex items-center justify-between rounded border border-border/70 p-2">
                  <div className="text-muted-foreground">
                    {run.runId.slice(0, 8)} · {run.invocationSource} · {run.status}
                  </div>
                  <div className="text-muted-foreground">
                    {normalizeRunTime(run)}s · {timeAgo(run.createdAt)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (!goal) return null;

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-xs uppercase text-muted-foreground">
            {goal.level}
          </span>
          <StatusBadge status={goal.status} />
        </div>

        <InlineEditor
          value={goal.title}
          onSave={(title) => updateGoal.mutate({ title })}
          as="h2"
          className="text-xl font-bold"
        />

        <InlineEditor
          value={goal.description ?? ""}
          onSave={(description) => updateGoal.mutate({ description })}
          as="p"
          className="text-sm text-muted-foreground"
          placeholder="Add a description..."
          multiline
          imageUploadHandler={async (file) => {
            const asset = await uploadImage.mutateAsync(file);
            return asset.contentPath;
          }}
        />
      </div>

      <Tabs defaultValue="children">
        <TabsList>
          <TabsTrigger value="children">
            Sub-Goals ({childGoals.length})
          </TabsTrigger>
          <TabsTrigger value="projects">
            Projects ({linkedProjects.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="children" className="mt-4 space-y-3">
          <div className="flex items-center justify-start">
            <Button
              size="sm"
              variant="outline"
              onClick={() => openNewGoal({ parentId: goalId })}
            >
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              Sub Goal
            </Button>
          </div>
          {childGoals.length === 0 ? (
            <p className="text-sm text-muted-foreground">No sub-goals.</p>
          ) : (
            <GoalTree goals={childGoals} goalLink={(g) => `/goals/${g.id}`} />
          )}
        </TabsContent>

        <TabsContent value="projects" className="mt-4">
          {linkedProjects.length === 0 ? (
            <p className="text-sm text-muted-foreground">No linked projects.</p>
          ) : (
            <div className="border border-border">
              {linkedProjects.map((project) => (
                <EntityRow
                  key={project.id}
                  title={project.name}
                  subtitle={project.description ?? undefined}
                  to={projectUrl(project)}
                  trailing={<StatusBadge status={project.status} />}
                />
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
