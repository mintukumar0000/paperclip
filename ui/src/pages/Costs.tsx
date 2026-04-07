import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { costsApi } from "../api/costs";
import { billingApi } from "../api/billing";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { formatCents, formatTokens } from "../lib/utils";
import { Identity } from "../components/Identity";
import { StatusBadge } from "../components/StatusBadge";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DollarSign } from "lucide-react";

type DatePreset = "mtd" | "7d" | "30d" | "ytd" | "all" | "custom";

const PRESET_LABELS: Record<DatePreset, string> = {
  mtd: "Month to Date",
  "7d": "Last 7 Days",
  "30d": "Last 30 Days",
  ytd: "Year to Date",
  all: "All Time",
  custom: "Custom",
};

function computeRange(preset: DatePreset): { from: string; to: string } {
  const now = new Date();
  const to = now.toISOString();
  switch (preset) {
    case "mtd": {
      const d = new Date(now.getFullYear(), now.getMonth(), 1);
      return { from: d.toISOString(), to };
    }
    case "7d": {
      const d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      return { from: d.toISOString(), to };
    }
    case "30d": {
      const d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      return { from: d.toISOString(), to };
    }
    case "ytd": {
      const d = new Date(now.getFullYear(), 0, 1);
      return { from: d.toISOString(), to };
    }
    case "all":
      return { from: "", to: "" };
    case "custom":
      return { from: "", to: "" };
  }
}

export function Costs() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  const [preset, setPreset] = useState<DatePreset>("mtd");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [checkoutError, setCheckoutError] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Costs" }]);
  }, [setBreadcrumbs]);

  const { from, to } = useMemo(() => {
    if (preset === "custom") {
      return {
        from: customFrom ? new Date(customFrom).toISOString() : "",
        to: customTo ? new Date(customTo + "T23:59:59.999Z").toISOString() : "",
      };
    }
    return computeRange(preset);
  }, [preset, customFrom, customTo]);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.costs(selectedCompanyId!, from || undefined, to || undefined),
    queryFn: async () => {
      const [summary, byAgent, byProject] = await Promise.all([
        costsApi.summary(selectedCompanyId!, from || undefined, to || undefined),
        costsApi.byAgent(selectedCompanyId!, from || undefined, to || undefined),
        costsApi.byProject(selectedCompanyId!, from || undefined, to || undefined),
      ]);
      return { summary, byAgent, byProject };
    },
    enabled: !!selectedCompanyId,
  });

  const financeQuery = useQuery({
    queryKey: queryKeys.billing.finance(selectedCompanyId!),
    queryFn: () => billingApi.financeSnapshot(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 2_000,
  });

  const checkoutMutation = useMutation({
    mutationFn: async () => {
      if (!selectedCompanyId) {
        throw new Error("Select a company before starting checkout.");
      }
      const origin = window.location.origin;
      return billingApi.createCheckoutSession(selectedCompanyId, {
        provider: "stripe",
        lineItems: [
          {
            name: "Paperclip Credits Top-up",
            amountCents: 5000,
            quantity: 1,
            currency: "usd",
          },
        ],
        mode: "payment",
        currency: "usd",
        successUrl: `${origin}/costs?checkout=success`,
        cancelUrl: `${origin}/costs?checkout=cancel`,
      });
    },
    onMutate: () => {
      setCheckoutError(null);
    },
    onSuccess: (response) => {
      const checkoutUrl = response.checkoutUrl ?? response.checkout_url ?? null;
      if (!checkoutUrl) {
        setCheckoutError("Checkout session was created but no redirect URL was returned.");
        return;
      }
      window.location.href = checkoutUrl;
    },
    onError: (err) => {
      setCheckoutError(err instanceof Error ? err.message : "Could not start checkout.");
    },
  });

  const walletSignals = useMemo(() => {
    const creditsCents = financeQuery.data?.creditsCents ?? 0;
    const spendCents = data?.summary.spendCents ?? 0;
    const budgetCents = data?.summary.budgetCents ?? 0;

    const fromMs = from ? new Date(from).getTime() : Number.NaN;
    const toMs = to ? new Date(to).getTime() : Number.NaN;
    const rangeMinutes =
      Number.isFinite(fromMs) && Number.isFinite(toMs) && toMs > fromMs
        ? Math.max(1, Math.round((toMs - fromMs) / 60000))
        : null;
    const burnCentsPerMinute = rangeMinutes ? spendCents / rangeMinutes : 0;
    const remainingMinutes = burnCentsPerMinute > 0 ? creditsCents / burnCentsPerMinute : null;

    const riskLevel =
      creditsCents <= 0 || (budgetCents > 0 && spendCents >= budgetCents)
        ? "HIGH"
        : remainingMinutes != null && remainingMinutes <= 240
          ? "MEDIUM"
          : "LOW";

    return {
      creditsCents,
      burnCentsPerMinute,
      remainingMinutes,
      riskLevel,
      budgetCents,
      spendCents,
    };
  }, [data?.summary.budgetCents, data?.summary.spendCents, financeQuery.data?.creditsCents, from, to]);

  if (!selectedCompanyId) {
    return <EmptyState icon={DollarSign} message="Select a company to view costs." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="costs" />;
  }

  const presetKeys: DatePreset[] = ["mtd", "7d", "30d", "ytd", "all", "custom"];

  return (
    <div className="space-y-6">
      {/* Date range selector */}
      <div className="flex flex-wrap items-center gap-2">
        {presetKeys.map((p) => (
          <Button
            key={p}
            variant={preset === p ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setPreset(p)}
          >
            {PRESET_LABELS[p]}
          </Button>
        ))}
        {preset === "custom" && (
          <div className="flex items-center gap-2 ml-2">
            <input
              type="date"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground"
            />
            <span className="text-sm text-muted-foreground">to</span>
            <input
              type="date"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground"
            />
          </div>
        )}
      </div>

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {data && (
        <>
          <Card>
            <CardContent className="p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm text-muted-foreground">Economic Wallet</p>
                <Button
                  size="sm"
                  onClick={() => checkoutMutation.mutate()}
                  disabled={checkoutMutation.isPending}
                >
                  {checkoutMutation.isPending ? "Opening Checkout..." : "Buy Credits"}
                </Button>
              </div>
              <div className="grid gap-3 md:grid-cols-3">
                <div className="rounded-md border border-border bg-muted/20 p-3">
                  <p className="text-xs text-muted-foreground">Credits</p>
                  <p className="text-xl font-semibold">
                    {formatCents(financeQuery.data?.creditsCents ?? 0)}
                  </p>
                </div>
                <div className="rounded-md border border-border bg-muted/20 p-3">
                  <p className="text-xs text-muted-foreground">Revenue</p>
                  <p className="text-xl font-semibold">
                    {formatCents(financeQuery.data?.revenueCents ?? 0)}
                  </p>
                </div>
                <div className="rounded-md border border-border bg-muted/20 p-3">
                  <p className="text-xs text-muted-foreground">Spent</p>
                  <p className="text-xl font-semibold">
                    {formatCents(financeQuery.data?.spentCents ?? 0)}
                  </p>
                </div>
              </div>

              {checkoutError && (
                <p className="mt-3 text-xs text-destructive">{checkoutError}</p>
              )}

              <div className="mt-3 rounded-md border border-border bg-muted/20 p-3 text-xs text-muted-foreground">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-foreground">
                    Budget Risk: {walletSignals.riskLevel}
                  </span>
                  <span>
                    Remaining: {formatCents(walletSignals.creditsCents)}
                  </span>
                  <span>
                    Burn rate: {walletSignals.burnCentsPerMinute > 0 ? `${formatCents(Math.round(walletSignals.burnCentsPerMinute))}/min` : "n/a"}
                  </span>
                </div>
                {walletSignals.remainingMinutes != null && (
                  <div className="mt-1">
                    Estimated runway: {walletSignals.remainingMinutes < 60
                      ? `${Math.max(1, Math.round(walletSignals.remainingMinutes))} min`
                      : `${Math.max(1, Math.round(walletSignals.remainingMinutes / 60))} h`}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Summary card */}
          <Card>
            <CardContent className="p-4 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">{PRESET_LABELS[preset]}</p>
                {data.summary.budgetCents > 0 && (
                  <p className="text-sm text-muted-foreground">
                    {data.summary.utilizationPercent}% utilized
                  </p>
                )}
              </div>
              <p className="text-2xl font-bold">
                {formatCents(data.summary.spendCents)}{" "}
                <span className="text-base font-normal text-muted-foreground">
                  {data.summary.budgetCents > 0
                    ? `/ ${formatCents(data.summary.budgetCents)}`
                    : "Unlimited budget"}
                </span>
              </p>
              {data.summary.budgetCents > 0 && (
                <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-[width,background-color] duration-150 ${
                      data.summary.utilizationPercent > 90
                        ? "bg-red-400"
                        : data.summary.utilizationPercent > 70
                          ? "bg-yellow-400"
                          : "bg-green-400"
                    }`}
                    style={{ width: `${Math.min(100, data.summary.utilizationPercent)}%` }}
                  />
                </div>
              )}
            </CardContent>
          </Card>

          {/* By Agent / By Project */}
          <div className="grid md:grid-cols-2 gap-4">
            <Card>
              <CardContent className="p-4">
                <h3 className="text-sm font-semibold mb-3">By Agent</h3>
                {data.byAgent.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No cost events yet.</p>
                ) : (
                  <div className="space-y-2">
                    {data.byAgent.map((row) => (
                      <div
                        key={row.agentId}
                        className="flex items-start justify-between text-sm"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <Identity
                            name={row.agentName ?? row.agentId}
                            size="sm"
                          />
                          {row.agentStatus === "terminated" && (
                            <StatusBadge status="terminated" />
                          )}
                        </div>
                        <div className="text-right shrink-0 ml-2">
                          <span className="font-medium block">{formatCents(row.costCents)}</span>
                          <span className="text-xs text-muted-foreground block">
                            in {formatTokens(row.inputTokens)} / out {formatTokens(row.outputTokens)} tok
                          </span>
                          {(row.apiRunCount > 0 || row.subscriptionRunCount > 0) && (
                            <span className="text-xs text-muted-foreground block">
                              {row.apiRunCount > 0 ? `api runs: ${row.apiRunCount}` : null}
                              {row.apiRunCount > 0 && row.subscriptionRunCount > 0 ? " | " : null}
                              {row.subscriptionRunCount > 0
                                ? `subscription runs: ${row.subscriptionRunCount} (${formatTokens(row.subscriptionInputTokens)} in / ${formatTokens(row.subscriptionOutputTokens)} out tok)`
                                : null}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-4">
                <h3 className="text-sm font-semibold mb-3">By Project</h3>
                {data.byProject.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No project-attributed run costs yet.</p>
                ) : (
                  <div className="space-y-2">
                    {data.byProject.map((row) => (
                      <div
                        key={row.projectId ?? "na"}
                        className="flex items-center justify-between text-sm"
                      >
                        <span className="truncate">
                          {row.projectName ?? row.projectId ?? "Unattributed"}
                        </span>
                        <span className="font-medium">{formatCents(row.costCents)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
