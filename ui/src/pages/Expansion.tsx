import { useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { expansionApi } from "../api/expansion";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Expand, AlertTriangle, CheckCircle, XCircle, Clock, ShieldCheck } from "lucide-react";

export function Expansion() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  useEffect(() => {
    setBreadcrumbs([{ label: "Expansion" }]);
  }, [setBreadcrumbs]);

  const { data: gaps, isLoading: loadingGaps } = useQuery({
    queryKey: queryKeys.expansion.gaps(selectedCompanyId!),
    queryFn: () => expansionApi.gaps(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: requests, isLoading: loadingReqs } = useQuery({
    queryKey: queryKeys.expansion.requests(selectedCompanyId!),
    queryFn: () => expansionApi.requests(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: limits } = useQuery({
    queryKey: queryKeys.expansion.limits(selectedCompanyId!),
    queryFn: () => expansionApi.limits(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const approveMutation = useMutation({
    mutationFn: (requestId: string) => expansionApi.approveRequest(selectedCompanyId!, requestId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.expansion.requests(selectedCompanyId!) });
    },
  });

  const rejectMutation = useMutation({
    mutationFn: (requestId: string) => expansionApi.rejectRequest(selectedCompanyId!, requestId, "Rejected by operator"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.expansion.requests(selectedCompanyId!) });
    },
  });

  if (!selectedCompanyId) return <EmptyState icon={Expand} message="Select a company to view expansion." />;
  if (loadingGaps || loadingReqs) return <PageSkeleton variant="list" />;

  const lim = limits as Record<string, any> | undefined;
  const agentPct = lim ? ((lim.currentAgents / lim.maxAgentsPerCompany) * 100) : 0;
  const deptPct = lim ? ((lim.currentDepartments / lim.maxDepartments) * 100) : 0;

  const pendingRequests = requests?.filter((r) => r.status === "pending") ?? [];

  return (
    <div className="space-y-6">
      {/* Expansion Limits */}
      {lim && (
        <div className="grid md:grid-cols-2 gap-4">
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-muted-foreground">Agents</span>
              <span className="text-xs font-mono text-foreground">{lim.currentAgents}/{lim.maxAgentsPerCompany}</span>
            </div>
            <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full ${agentPct > 85 ? "bg-red-400" : agentPct > 60 ? "bg-yellow-400" : "bg-green-400"}`}
                style={{ width: `${Math.min(agentPct, 100)}%` }}
              />
            </div>
          </div>
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-muted-foreground">Departments</span>
              <span className="text-xs font-mono text-foreground">{lim.currentDepartments}/{lim.maxDepartments}</span>
            </div>
            <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full ${deptPct > 85 ? "bg-red-400" : deptPct > 60 ? "bg-yellow-400" : "bg-green-400"}`}
                style={{ width: `${Math.min(deptPct, 100)}%` }}
              />
            </div>
          </div>
        </div>
      )}

      {/* Capability Gaps */}
      <section>
        <h2 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-yellow-500" />
          Capability Gaps
        </h2>
        {(!gaps || gaps.length === 0) ? (
          <EmptyState icon={ShieldCheck} message="No capability gaps detected." />
        ) : (
          <div className="space-y-2">
            {gaps.map((gap, i) => (
              <div key={i} className="rounded-lg border border-border bg-card p-3">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-sm font-medium text-foreground">{gap.role}</span>
                  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
                    gap.severity === "critical" ? "bg-red-500/10 text-red-500" :
                    gap.severity === "high" ? "bg-orange-500/10 text-orange-500" :
                    "bg-yellow-500/10 text-yellow-500"
                  }`}>{gap.severity}</span>
                </div>
                <p className="text-xs text-muted-foreground">{gap.description}</p>
                <p className="text-xs text-cyan-500 mt-1">→ {gap.recommendation}</p>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Pending Expansion Requests */}
      {pendingRequests.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
            <Clock className="h-4 w-4 text-yellow-500" />
            Pending Requests ({pendingRequests.length})
          </h2>
          <div className="space-y-2">
            {pendingRequests.map((req) => (
              <div key={req.id} className="rounded-lg border border-yellow-500/20 bg-card p-3">
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground">{req.requestType.replace(/_/g, " ")}</span>
                    {req.requestedRole && (
                      <span className="text-xs text-muted-foreground">→ {req.requestedRole}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-xs text-green-500 hover:text-green-400"
                      onClick={() => approveMutation.mutate(req.id)}
                      disabled={approveMutation.isPending}
                    >
                      <CheckCircle className="h-3 w-3 mr-1" /> Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-xs text-red-500 hover:text-red-400"
                      onClick={() => rejectMutation.mutate(req.id)}
                      disabled={rejectMutation.isPending}
                    >
                      <XCircle className="h-3 w-3 mr-1" /> Reject
                    </Button>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">{req.reason}</p>
                <p className="text-xs text-muted-foreground mt-1">Approval: {req.approvalLevel}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* All Requests */}
      <section>
        <h2 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
          <Expand className="h-4 w-4 text-blue-500" />
          All Expansion Requests
        </h2>
        {(!requests || requests.length === 0) ? (
          <EmptyState icon={Expand} message="No expansion requests yet." />
        ) : (
          <div className="rounded-lg border border-border overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-accent/20 text-muted-foreground">
                  <th className="text-left px-3 py-2 font-medium">Type</th>
                  <th className="text-left px-3 py-2 font-medium">Role</th>
                  <th className="text-left px-3 py-2 font-medium">Status</th>
                  <th className="text-left px-3 py-2 font-medium">Approval</th>
                  <th className="text-left px-3 py-2 font-medium">Date</th>
                </tr>
              </thead>
              <tbody>
                {requests.map((req) => (
                  <tr key={req.id} className="border-t border-border hover:bg-accent/50">
                    <td className="px-3 py-2 text-foreground">{req.requestType.replace(/_/g, " ")}</td>
                    <td className="px-3 py-2 text-muted-foreground">{req.requestedRole ?? "—"}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
                        req.status === "approved" || req.status === "completed" ? "bg-green-500/10 text-green-500" :
                        req.status === "rejected" ? "bg-red-500/10 text-red-500" :
                        "bg-yellow-500/10 text-yellow-500"
                      }`}>{req.status}</span>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{req.approvalLevel}</td>
                    <td className="px-3 py-2 text-muted-foreground">{new Date(req.createdAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
