import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { economyApi } from "../api/economy";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Store, ArrowRightLeft, BarChart3, TrendingUp } from "lucide-react";

export function Economy() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Economy" }]);
  }, [setBreadcrumbs]);

  const { data: analysis, isLoading: loadingAnalysis } = useQuery({
    queryKey: queryKeys.economy.analysis,
    queryFn: () => economyApi.analysis(),
  });

  const { data: companyServices, isLoading: loadingServices } = useQuery({
    queryKey: queryKeys.economy.companyServices(selectedCompanyId!),
    queryFn: () => economyApi.companyServices(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: companyContracts, isLoading: loadingContracts } = useQuery({
    queryKey: queryKeys.economy.companyContracts(selectedCompanyId!),
    queryFn: () => economyApi.companyContracts(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  if (!selectedCompanyId) return <EmptyState icon={Store} message="Select a company to view economy." />;
  if (loadingAnalysis || loadingServices || loadingContracts) return <PageSkeleton variant="list" />;

  const an = analysis as Record<string, any> | undefined;

  return (
    <div className="space-y-6">
      {/* Economy Overview */}
      <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="rounded-lg border border-border bg-card p-4 text-center">
          <div className="flex justify-center mb-2"><Store className="h-5 w-5 text-muted-foreground" /></div>
          <div className="text-2xl font-bold text-foreground">{an?.activeServices ?? 0}</div>
          <div className="text-xs text-muted-foreground">Active Services</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4 text-center">
          <div className="flex justify-center mb-2"><ArrowRightLeft className="h-5 w-5 text-muted-foreground" /></div>
          <div className="text-2xl font-bold text-foreground">{an?.activeContracts ?? 0}</div>
          <div className="text-xs text-muted-foreground">Active Contracts</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4 text-center">
          <div className="flex justify-center mb-2"><TrendingUp className="h-5 w-5 text-green-500" /></div>
          <div className="text-2xl font-bold text-foreground">
            ${((an?.totalRevenueCents ?? 0) / 100).toFixed(2)}
          </div>
          <div className="text-xs text-muted-foreground">Total Revenue</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4 text-center">
          <div className="flex justify-center mb-2"><BarChart3 className="h-5 w-5 text-blue-500" /></div>
          <div className="text-2xl font-bold text-foreground">
            ${((an?.totalSpendCents ?? 0) / 100).toFixed(2)}
          </div>
          <div className="text-xs text-muted-foreground">Total Spend</div>
        </div>
      </div>

      {/* Company Services */}
      <section>
        <h2 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
          <Store className="h-4 w-4 text-purple-500" />
          Company Services
        </h2>
        {(!companyServices || companyServices.length === 0) ? (
          <EmptyState icon={Store} message="No services registered for this company." />
        ) : (
          <div className="rounded-lg border border-border overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-accent/20 text-muted-foreground">
                  <th className="text-left px-3 py-2 font-medium">Service</th>
                  <th className="text-left px-3 py-2 font-medium">Category</th>
                  <th className="text-right px-3 py-2 font-medium">Price</th>
                  <th className="text-left px-3 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {companyServices.map((svc) => (
                  <tr key={svc.id} className="border-t border-border hover:bg-accent/50">
                    <td className="px-3 py-2 text-foreground font-medium">{svc.name}</td>
                    <td className="px-3 py-2 text-muted-foreground">{svc.category}</td>
                    <td className="px-3 py-2 text-right font-mono text-foreground">
                      ${(svc.pricePerRequestCents / 100).toFixed(2)}
                    </td>
                    <td className="px-3 py-2">
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
                        svc.status === "active" ? "bg-green-500/10 text-green-500" : "bg-muted text-muted-foreground"
                      }`}>{svc.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Contracts */}
      <section>
        <h2 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
          <ArrowRightLeft className="h-4 w-4 text-cyan-500" />
          Contracts
        </h2>
        {(!companyContracts || companyContracts.length === 0) ? (
          <EmptyState icon={ArrowRightLeft} message="No contracts yet for this company." />
        ) : (
          <div className="rounded-lg border border-border overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-accent/20 text-muted-foreground">
                  <th className="text-left px-3 py-2 font-medium">Contract</th>
                  <th className="text-left px-3 py-2 font-medium">Status</th>
                  <th className="text-right px-3 py-2 font-medium">Price/Req</th>
                  <th className="text-right px-3 py-2 font-medium">Executions</th>
                  <th className="text-right px-3 py-2 font-medium">Success Rate</th>
                </tr>
              </thead>
              <tbody>
                {companyContracts.map((c) => (
                  <tr key={c.id} className="border-t border-border hover:bg-accent/50">
                    <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{c.id.slice(0, 8)}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
                        c.status === "active" ? "bg-green-500/10 text-green-500" :
                        c.status === "cancelled" ? "bg-red-500/10 text-red-500" :
                        "bg-muted text-muted-foreground"
                      }`}>{c.status}</span>
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-foreground">
                      ${(c.pricePerRequestCents / 100).toFixed(2)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-foreground">{c.totalExecutions}</td>
                    <td className="px-3 py-2 text-right font-mono text-foreground">
                      {(c.successRate * 100).toFixed(1)}%
                    </td>
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
