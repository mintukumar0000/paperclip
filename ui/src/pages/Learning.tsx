import { useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { learningApi } from "../api/learning";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { GraduationCap, RefreshCw, CheckCircle, RotateCcw, Lightbulb, FlaskConical, BarChart3 } from "lucide-react";

export function Learning() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  useEffect(() => {
    setBreadcrumbs([{ label: "Learning" }]);
  }, [setBreadcrumbs]);

  const { data: records, isLoading: loadingRecords } = useQuery({
    queryKey: queryKeys.learning.records(selectedCompanyId!),
    queryFn: () => learningApi.records(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: improvements, isLoading: loadingImps } = useQuery({
    queryKey: queryKeys.learning.improvements(selectedCompanyId!),
    queryFn: () => learningApi.improvements(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const cycleMutation = useMutation({
    mutationFn: () => learningApi.runCycle(selectedCompanyId!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.learning.records(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.learning.improvements(selectedCompanyId!) });
    },
  });

  const applyMutation = useMutation({
    mutationFn: (planId: string) => learningApi.applyImprovement(selectedCompanyId!, planId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.learning.improvements(selectedCompanyId!) });
    },
  });

  const rollbackMutation = useMutation({
    mutationFn: (planId: string) => learningApi.rollbackImprovement(selectedCompanyId!, planId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.learning.improvements(selectedCompanyId!) });
    },
  });

  if (!selectedCompanyId) return <EmptyState icon={GraduationCap} message="Select a company to view learning." />;
  if (loadingRecords || loadingImps) return <PageSkeleton variant="list" />;

  // Group records by type
  const evaluations = records?.filter((r) => r.recordType === "evaluation") ?? [];
  const insights = records?.filter((r) => r.recordType === "insight") ?? [];
  const optimizations = records?.filter((r) => r.recordType === "optimization") ?? [];

  const recordTypeIcon = (type: string) => {
    switch (type) {
      case "evaluation": return <BarChart3 className="h-3.5 w-3.5 text-blue-500" />;
      case "insight": return <Lightbulb className="h-3.5 w-3.5 text-yellow-500" />;
      case "optimization": return <FlaskConical className="h-3.5 w-3.5 text-purple-500" />;
      default: return <GraduationCap className="h-3.5 w-3.5 text-muted-foreground" />;
    }
  };

  return (
    <div className="space-y-6">
      {/* Actions */}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => cycleMutation.mutate()}
          disabled={cycleMutation.isPending}
        >
          <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${cycleMutation.isPending ? "animate-spin" : ""}`} />
          {cycleMutation.isPending ? "Running..." : "Run Learning Cycle"}
        </Button>
      </div>

      {/* Overview Stats */}
      <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="rounded-lg border border-border bg-card p-4 text-center">
          <div className="text-2xl font-bold text-foreground">{records?.length ?? 0}</div>
          <div className="text-xs text-muted-foreground">Total Records</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4 text-center">
          <div className="text-2xl font-bold text-foreground">{evaluations.length}</div>
          <div className="text-xs text-muted-foreground">Evaluations</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4 text-center">
          <div className="text-2xl font-bold text-foreground">{insights.length}</div>
          <div className="text-xs text-muted-foreground">Insights</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4 text-center">
          <div className="text-2xl font-bold text-foreground">{improvements?.length ?? 0}</div>
          <div className="text-xs text-muted-foreground">Improvement Plans</div>
        </div>
      </div>

      {/* Improvement Plans */}
      <section>
        <h2 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
          <FlaskConical className="h-4 w-4 text-purple-500" />
          Improvement Plans
        </h2>
        {(!improvements || improvements.length === 0) ? (
          <EmptyState icon={FlaskConical} message="No improvement plans yet. Run a learning cycle." />
        ) : (
          <div className="space-y-2">
            {improvements.map((plan) => (
              <div key={plan.id} className="rounded-lg border border-border bg-card p-3">
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
                      plan.applied && !plan.rolledBack ? "bg-green-500/10 text-green-500" :
                      plan.rolledBack ? "bg-red-500/10 text-red-500" :
                      "bg-yellow-500/10 text-yellow-500"
                    }`}>
                      {plan.rolledBack ? "rolled back" : plan.applied ? "applied" : "pending"}
                    </span>
                    <span className="text-xs text-muted-foreground">{plan.category}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    {!plan.applied && !plan.rolledBack && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-xs text-green-500 hover:text-green-400"
                        onClick={() => applyMutation.mutate(plan.id)}
                        disabled={applyMutation.isPending}
                      >
                        <CheckCircle className="h-3 w-3 mr-1" /> Apply
                      </Button>
                    )}
                    {plan.applied && !plan.rolledBack && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-xs text-red-500 hover:text-red-400"
                        onClick={() => rollbackMutation.mutate(plan.id)}
                        disabled={rollbackMutation.isPending}
                      >
                        <RotateCcw className="h-3 w-3 mr-1" /> Rollback
                      </Button>
                    )}
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">{plan.summary}</p>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Recent Learning Records */}
      <section>
        <h2 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
          <GraduationCap className="h-4 w-4 text-cyan-500" />
          Recent Learning Records
        </h2>
        {(!records || records.length === 0) ? (
          <EmptyState icon={GraduationCap} message="No learning records yet." />
        ) : (
          <div className="space-y-2">
            {records.slice(0, 20).map((rec) => (
              <div key={rec.id} className="rounded-lg border border-border bg-card p-3 flex items-start gap-3">
                {recordTypeIcon(rec.recordType)}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-xs font-medium text-foreground">{rec.recordType}</span>
                    <span className="text-xs text-muted-foreground">·</span>
                    <span className="text-xs text-muted-foreground">{rec.category}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">{rec.summary}</p>
                  {rec.recommendedChange && (
                    <p className="text-xs text-cyan-500 mt-1">→ {rec.recommendedChange}</p>
                  )}
                </div>
                <span className="text-xs text-muted-foreground shrink-0">
                  {new Date(rec.createdAt).toLocaleDateString()}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
