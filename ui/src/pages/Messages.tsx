import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { messagesApi } from "../api/messages";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { MessageSquare } from "lucide-react";

export function Messages() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Messages" }]);
  }, [setBreadcrumbs]);

  const { data: messages, isLoading, error } = useQuery({
    queryKey: queryKeys.messages.list(selectedCompanyId!),
    queryFn: () => messagesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 10_000,
  });

  if (!selectedCompanyId) return <EmptyState icon={MessageSquare} message="Select a company to view messages." />;
  if (isLoading) return <PageSkeleton variant="list" />;

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-destructive">{error instanceof Error ? error.message : "Failed to load"}</p>}

      {messages && messages.length === 0 && (
        <EmptyState icon={MessageSquare} message="No agent messages yet. Agents will communicate here during workflows." />
      )}

      {messages && messages.length > 0 && (
        <div className="space-y-2">
          {messages.map((msg: any) => (
            <div key={msg.id} className="rounded-lg border border-border bg-card p-3 space-y-1">
              <div className="flex items-center gap-2 text-xs">
                <span className="font-medium text-foreground">{msg.fromAgentId?.slice(0, 8)}</span>
                <span className="text-muted-foreground">→</span>
                <span className="font-medium text-foreground">{msg.toAgentId?.slice(0, 8)}</span>
                <span className={`ml-auto inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
                  msg.status === "read" ? "bg-green-500/10 text-green-500" :
                  msg.status === "acted_on" ? "bg-blue-500/10 text-blue-500" :
                  "bg-muted text-muted-foreground"
                }`}>
                  {msg.status}
                </span>
              </div>
              <p className="text-sm text-foreground">{msg.message}</p>
              <div className="text-[10px] text-muted-foreground">
                {msg.createdAt && new Date(msg.createdAt).toLocaleString()}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
