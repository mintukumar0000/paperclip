import { useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { workflowsApi } from "../api/workflows";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { GitBranch, Play } from "lucide-react";

export function Workflows() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  useEffect(() => {
    setBreadcrumbs([{ label: "Workflows" }]);
  }, [setBreadcrumbs]);

  const { data: workflows, isLoading, error } = useQuery({
    queryKey: queryKeys.workflows.list(selectedCompanyId!),
    queryFn: () => workflowsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: runs } = useQuery({
    queryKey: queryKeys.workflows.runs(selectedCompanyId!),
    queryFn: () => workflowsApi.listRuns(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const triggerMutation = useMutation({
    mutationFn: (workflowId: string) => workflowsApi.trigger(workflowId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workflows.runs(selectedCompanyId!) });
    },
  });

  if (!selectedCompanyId) return <EmptyState icon={GitBranch} message="Select a company to view workflows." />;
  if (isLoading) return <PageSkeleton variant="list" />;

  return (
    <div className="space-y-6">
      {error && <p className="text-sm text-destructive">{error instanceof Error ? error.message : "Failed to load"}</p>}

      <section>
        <h2 className="text-sm font-semibold text-foreground mb-3">Workflow Definitions</h2>
        {workflows && workflows.length === 0 && (
          <EmptyState icon={GitBranch} message="No workflows defined yet." />
        )}
        {workflows && workflows.length > 0 && (
          <div className="space-y-2">
            {workflows.map((wf: any) => (
              <div key={wf.id} className="flex items-center justify-between rounded-lg border border-border bg-card p-3">
                <div>
                  <span className="text-sm font-medium text-foreground">{wf.name}</span>
                  {wf.description && (
                    <p className="text-xs text-muted-foreground mt-0.5">{wf.description}</p>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {Array.isArray(wf.definition) ? `${wf.definition.length} steps` : ""}
                  </span>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => triggerMutation.mutate(wf.id)}
                  disabled={triggerMutation.isPending}
                >
                  <Play className="h-3.5 w-3.5 mr-1.5" />
                  Run
                </Button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-sm font-semibold text-foreground mb-3">Recent Runs</h2>
        {runs && runs.length === 0 && (
          <p className="text-xs text-muted-foreground">No workflow runs yet.</p>
        )}
        {runs && runs.length > 0 && (
          <div className="space-y-1">
            {runs.map((run: any) => (
              <div key={run.id} className="flex items-center gap-3 rounded-md border border-border bg-card px-3 py-2 text-xs">
                <span className={`inline-flex items-center rounded-full px-2 py-0.5 font-medium ${
                  run.status === "completed" ? "bg-green-500/10 text-green-500" :
                  run.status === "failed" ? "bg-red-500/10 text-red-500" :
                  run.status === "running" ? "bg-blue-500/10 text-blue-500" :
                  "bg-muted text-muted-foreground"
                }`}>
                  {run.status}
                </span>
                <span className="text-muted-foreground">{run.id.slice(0, 8)}</span>
                {run.startedAt && (
                  <span className="text-muted-foreground ml-auto">
                    {new Date(run.startedAt).toLocaleString()}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
