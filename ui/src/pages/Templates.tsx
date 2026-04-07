import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { templatesApi } from "../api/templates";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Blocks, Rocket } from "lucide-react";

export function Templates() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [deployingId, setDeployingId] = useState<string | null>(null);
  const [companyName, setCompanyName] = useState("");

  useEffect(() => {
    setBreadcrumbs([{ label: "Templates" }]);
  }, [setBreadcrumbs]);

  const { data: templates, isLoading, error } = useQuery({
    queryKey: queryKeys.templates.all,
    queryFn: () => templatesApi.list(),
  });

  const deployMutation = useMutation({
    mutationFn: ({ templateId, name }: { templateId: string; name: string }) =>
      templatesApi.deploy(templateId, name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      setDeployingId(null);
      setCompanyName("");
    },
  });

  if (isLoading) return <PageSkeleton variant="list" />;

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-destructive">{error instanceof Error ? error.message : "Failed to load templates"}</p>}

      {templates && templates.length === 0 && (
        <EmptyState icon={Blocks} message="No templates available." />
      )}

      {templates && templates.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {templates.map((t) => (
            <div key={t.id} className="rounded-lg border border-border bg-card p-4 space-y-3">
              <div>
                <h3 className="text-sm font-semibold text-foreground">{t.name}</h3>
                <p className="text-xs text-muted-foreground mt-1">{t.description}</p>
              </div>

              {deployingId === t.id ? (
                <div className="space-y-2">
                  <input
                    type="text"
                    placeholder="Company name..."
                    value={companyName}
                    onChange={(e) => setCompanyName(e.target.value)}
                    className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm"
                    autoFocus
                  />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      onClick={() => deployMutation.mutate({ templateId: t.id, name: companyName })}
                      disabled={!companyName.trim() || deployMutation.isPending}
                    >
                      <Rocket className="h-3.5 w-3.5 mr-1.5" />
                      {deployMutation.isPending ? "Deploying..." : "Deploy"}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setDeployingId(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <Button size="sm" variant="outline" onClick={() => setDeployingId(t.id)}>
                  <Rocket className="h-3.5 w-3.5 mr-1.5" />
                  Deploy Template
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
