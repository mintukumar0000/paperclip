import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { ecosystemApi } from "../api/ecosystem";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Globe, TrendingUp, Lightbulb, CheckCircle, XCircle, Clock } from "lucide-react";

export function Ecosystem() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Ecosystem" }]);
  }, [setBreadcrumbs]);

  const { data: opportunities, isLoading: loadingOpps } = useQuery({
    queryKey: queryKeys.ecosystem.opportunities(selectedCompanyId!),
    queryFn: () => ecosystemApi.opportunities(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: requests, isLoading: loadingReqs } = useQuery({
    queryKey: queryKeys.ecosystem.requests(selectedCompanyId!),
    queryFn: () => ecosystemApi.requests(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: ecosystemStatus } = useQuery({
    queryKey: queryKeys.ecosystem.status,
    queryFn: () => ecosystemApi.status(),
  });

  if (!selectedCompanyId) return <EmptyState icon={Globe} message="Select a company to view ecosystem." />;
  if (loadingOpps || loadingReqs) return <PageSkeleton variant="list" />;

  const statusIcon = (status: string) => {
    switch (status) {
      case "approved": case "completed": return <CheckCircle className="h-3.5 w-3.5 text-green-500" />;
      case "rejected": return <XCircle className="h-3.5 w-3.5 text-red-500" />;
      default: return <Clock className="h-3.5 w-3.5 text-yellow-500" />;
    }
  };

  return (
    <div className="space-y-6">
      {/* Ecosystem Overview */}
      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-lg border border-border bg-card p-4 text-center">
          <div className="text-2xl font-bold text-foreground">{ecosystemStatus?.companies ?? 0}</div>
          <div className="text-xs text-muted-foreground">Companies</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4 text-center">
          <div className="text-2xl font-bold text-foreground">{ecosystemStatus?.totalAgents ?? 0}</div>
          <div className="text-xs text-muted-foreground">Total Agents</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4 text-center">
          <div className="text-2xl font-bold text-foreground">{opportunities?.length ?? 0}</div>
          <div className="text-xs text-muted-foreground">Opportunities</div>
        </div>
      </div>

      {/* Opportunities */}
      <section>
        <h2 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
          <Lightbulb className="h-4 w-4 text-yellow-500" />
          Market Opportunities
        </h2>
        {(!opportunities || opportunities.length === 0) ? (
          <EmptyState icon={TrendingUp} message="No opportunities discovered yet. Run the opportunity scanner." />
        ) : (
          <div className="space-y-2">
            {opportunities.map((opp) => (
              <div key={opp.id} className="rounded-lg border border-border bg-card p-3">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-medium text-foreground">{opp.title}</span>
                  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
                    opp.potentialRevenue === "high" ? "bg-green-500/10 text-green-500" :
                    opp.potentialRevenue === "medium" ? "bg-yellow-500/10 text-yellow-500" :
                    "bg-muted text-muted-foreground"
                  }`}>{opp.potentialRevenue} revenue</span>
                </div>
                <p className="text-xs text-muted-foreground mb-2">{opp.description}</p>
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span>Category: <span className="text-foreground">{opp.marketCategory}</span></span>
                  <span>Confidence: <span className="text-foreground">{(opp.confidence * 100).toFixed(0)}%</span></span>
                  <span>Source: <span className="text-foreground">{opp.sourceType.replace(/_/g, " ")}</span></span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Expansion Requests */}
      <section>
        <h2 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
          <Globe className="h-4 w-4 text-blue-500" />
          Ecosystem Requests
        </h2>
        {(!requests || requests.length === 0) ? (
          <EmptyState icon={Globe} message="No ecosystem requests yet." />
        ) : (
          <div className="space-y-2">
            {requests.map((req) => (
              <div key={req.id} className="rounded-lg border border-border bg-card p-3 flex items-center gap-3">
                {statusIcon(req.status)}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground">{req.requestType.replace(/_/g, " ")}</span>
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
                      req.status === "approved" || req.status === "completed" ? "bg-green-500/10 text-green-500" :
                      req.status === "rejected" ? "bg-red-500/10 text-red-500" :
                      "bg-yellow-500/10 text-yellow-500"
                    }`}>{req.status}</span>
                  </div>
                  <p className="text-xs text-muted-foreground truncate">{req.reason}</p>
                </div>
                <span className="text-xs text-muted-foreground shrink-0">
                  {new Date(req.createdAt).toLocaleDateString()}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
