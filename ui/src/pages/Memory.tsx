import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { memoryApi } from "../api/memory";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Brain, Search } from "lucide-react";

export function Memory() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [searchQuery, setSearchQuery] = useState("");
  const [activeSearch, setActiveSearch] = useState("");

  useEffect(() => {
    setBreadcrumbs([{ label: "Memory" }]);
  }, [setBreadcrumbs]);

  const { data: memories, isLoading, error } = useQuery({
    queryKey: queryKeys.memories.list(selectedCompanyId!),
    queryFn: () => memoryApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && !activeSearch,
  });

  const { data: searchResults } = useQuery({
    queryKey: queryKeys.memories.search(selectedCompanyId!, activeSearch),
    queryFn: () => memoryApi.search(selectedCompanyId!, activeSearch),
    enabled: !!selectedCompanyId && !!activeSearch,
  });

  const displayedMemories = activeSearch ? searchResults : memories;

  if (!selectedCompanyId) return <EmptyState icon={Brain} message="Select a company to view memory." />;
  if (isLoading) return <PageSkeleton variant="list" />;

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-destructive">{error instanceof Error ? error.message : "Failed to load"}</p>}

      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search memories..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") setActiveSearch(searchQuery); }}
            className="w-full rounded-md border border-border bg-background pl-8 pr-3 py-1.5 text-sm"
          />
        </div>
        {activeSearch && (
          <button
            onClick={() => { setActiveSearch(""); setSearchQuery(""); }}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Clear search
          </button>
        )}
      </div>

      {displayedMemories && displayedMemories.length === 0 && (
        <EmptyState icon={Brain} message={activeSearch ? "No memories match your search." : "No memories stored yet."} />
      )}

      {displayedMemories && displayedMemories.length > 0 && (
        <div className="space-y-2">
          {displayedMemories.map((m: any) => (
            <div key={m.id} className="rounded-lg border border-border bg-card p-3 space-y-1">
              <div className="flex items-center gap-2">
                <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
                  m.type === "knowledge" ? "bg-blue-500/10 text-blue-500" :
                  m.type === "decision" ? "bg-purple-500/10 text-purple-500" :
                  m.type === "experiment" ? "bg-orange-500/10 text-orange-500" :
                  "bg-muted text-muted-foreground"
                }`}>
                  {m.type}
                </span>
                <h3 className="text-sm font-medium text-foreground">{m.title}</h3>
              </div>
              <p className="text-xs text-muted-foreground line-clamp-2">{m.content}</p>
              <div className="text-[10px] text-muted-foreground">
                {m.createdAt && new Date(m.createdAt).toLocaleString()}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
