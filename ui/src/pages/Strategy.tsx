import { useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { strategyApi } from "../api/strategy";
import { executionLoopApi } from "../api/executionLoop";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Sparkles, Play, RefreshCw } from "lucide-react";

export function Strategy() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  useEffect(() => {
    setBreadcrumbs([{ label: "Strategy" }]);
  }, [setBreadcrumbs]);

  const { data: plans, isLoading, error } = useQuery({
    queryKey: queryKeys.strategy.plans(selectedCompanyId!),
    queryFn: () => strategyApi.listPlans(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const analyzeMutation = useMutation({
    mutationFn: () => strategyApi.analyze(selectedCompanyId!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.strategy.plans(selectedCompanyId!) });
    },
  });

  const loopMutation = useMutation({
    mutationFn: () => executionLoopApi.runCycle(selectedCompanyId!),
  });

  if (!selectedCompanyId) return <EmptyState icon={Sparkles} message="Select a company to view strategy." />;
  if (isLoading) return <PageSkeleton variant="list" />;

  return (
    <div className="space-y-6">
      {error && <p className="text-sm text-destructive">{error instanceof Error ? error.message : "Failed to load"}</p>}

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => analyzeMutation.mutate()}
          disabled={analyzeMutation.isPending}
        >
          <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${analyzeMutation.isPending ? "animate-spin" : ""}`} />
          {analyzeMutation.isPending ? "Analyzing..." : "Run Analysis"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => loopMutation.mutate()}
          disabled={loopMutation.isPending}
        >
          <Play className="h-3.5 w-3.5 mr-1.5" />
          {loopMutation.isPending ? "Running..." : "Run Execution Loop"}
        </Button>
      </div>

      {analyzeMutation.data && (
        <div className="rounded-lg border border-border bg-card p-4 space-y-3">
          <h3 className="text-sm font-semibold text-foreground">Latest Analysis</h3>
          <div className="grid grid-cols-3 gap-4 text-center">
            <div>
              <div className="text-2xl font-bold text-foreground">
                {analyzeMutation.data.goalSnapshots?.length ?? 0}
              </div>
              <div className="text-xs text-muted-foreground">Goals Analyzed</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-foreground">
                {analyzeMutation.data.generatedTasks?.length ?? 0}
              </div>
              <div className="text-xs text-muted-foreground">Tasks Generated</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-foreground">
                {analyzeMutation.data.staleGoalIds?.length ?? 0}
              </div>
              <div className="text-xs text-muted-foreground">Stale Goals</div>
            </div>
          </div>
        </div>
      )}

      {loopMutation.data && (
        <div className="rounded-lg border border-green-500/20 bg-green-500/5 p-4 space-y-1">
          <h3 className="text-sm font-semibold text-green-500">Execution Loop Completed</h3>
          <p className="text-xs text-muted-foreground">
            Dispatched {loopMutation.data.tasksDispatched} tasks to {loopMutation.data.agentsActivated} agents.
          </p>
        </div>
      )}

      <section>
        <h2 className="text-sm font-semibold text-foreground mb-3">Strategy Plans</h2>
        {plans && plans.length === 0 && (
          <EmptyState icon={Sparkles} message="No strategy plans yet. Run an analysis to create one." />
        )}
        {plans && plans.length > 0 && (
          <div className="space-y-2">
            {plans.map((plan: any) => (
              <div key={plan.id} className="rounded-lg border border-border bg-card p-3">
                <div className="flex items-center gap-2 mb-1">
                  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
                    plan.status === "applied" ? "bg-green-500/10 text-green-500" :
                    plan.status === "rejected" ? "bg-red-500/10 text-red-500" :
                    "bg-yellow-500/10 text-yellow-500"
                  }`}>
                    {plan.status}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {plan.createdAt && new Date(plan.createdAt).toLocaleString()}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {Array.isArray(plan.generatedTasks) ? `${plan.generatedTasks.length} tasks generated` : ""}
                </p>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
