import {
  Inbox,
  CircleDot,
  Target,
  LayoutDashboard,
  DollarSign,
  History,
  Search,
  SquarePen,
  Network,
  Settings,
  Blocks,
  GitBranch,
  Brain,
  Sparkles,
  MessageSquare,
  Activity,
  Globe,
  Store,
  GraduationCap,
  Expand,
  Shield,
  HeartPulse,
  FlaskConical,
  Command,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { SidebarSection } from "./SidebarSection";
import { SidebarNavItem } from "./SidebarNavItem";
import { SidebarProjects } from "./SidebarProjects";
import { SidebarAgents } from "./SidebarAgents";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { sidebarBadgesApi } from "../api/sidebarBadges";
import { heartbeatsApi } from "../api/heartbeats";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";

export function Sidebar() {
  const { openNewIssue } = useDialog();
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { data: sidebarBadges } = useQuery({
    queryKey: queryKeys.sidebarBadges(selectedCompanyId!),
    queryFn: () => sidebarBadgesApi.get(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(selectedCompanyId!),
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 10_000,
  });
  const liveRunCount = liveRuns?.length ?? 0;

  function openSearch() {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
  }

  return (
    <aside className="w-60 h-full min-h-0 border-r border-border bg-background flex flex-col">
      {/* Top bar: Company name (bold) + Search — aligned with top sections (no visible border) */}
      <div className="flex items-center gap-1 px-3 h-12 shrink-0">
        {selectedCompany?.brandColor && (
          <div
            className="w-4 h-4 rounded-sm shrink-0 ml-1"
            style={{ backgroundColor: selectedCompany.brandColor }}
          />
        )}
        <span className="flex-1 text-sm font-bold text-foreground truncate pl-1">
          {selectedCompany?.name ?? "Select company"}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground shrink-0"
          onClick={openSearch}
        >
          <Search className="h-4 w-4" />
        </Button>
      </div>

      <nav className="flex-1 min-h-0 overflow-y-auto scrollbar-none flex flex-col gap-4 px-3 py-2">
        <div className="flex flex-col gap-0.5">
          {/* New Issue button aligned with nav items */}
          <button
            onClick={() => openNewIssue()}
            className="flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors"
          >
            <SquarePen className="h-4 w-4 shrink-0" />
            <span className="truncate">New Issue</span>
          </button>
          <SidebarNavItem to="/dashboard" label="Dashboard" icon={LayoutDashboard} liveCount={liveRunCount} />
          <SidebarNavItem
            to="/inbox"
            label="Inbox"
            icon={Inbox}
            badge={sidebarBadges?.inbox}
            badgeTone={sidebarBadges?.failedRuns ? "danger" : "default"}
            alert={(sidebarBadges?.failedRuns ?? 0) > 0}
          />
        </div>

        <SidebarSection label="Work">
          <SidebarNavItem to="/issues" label="Issues" icon={CircleDot} />
          <SidebarNavItem to="/goals" label="Goals" icon={Target} />
          <SidebarNavItem to="/workflows" label="Workflows" icon={GitBranch} />
        </SidebarSection>

        <SidebarProjects />

        <SidebarAgents />

        <SidebarSection label="Intelligence">
          <SidebarNavItem to="/command-center" label="Command Center" icon={Command} />
          <SidebarNavItem to="/strategy" label="Strategy" icon={Sparkles} />
          <SidebarNavItem to="/memory" label="Memory" icon={Brain} />
          <SidebarNavItem to="/messages" label="Messages" icon={MessageSquare} />
          <SidebarNavItem to="/ai-dashboard" label="AI Dashboard" icon={Activity} />
          <SidebarNavItem to="/learning" label="Learning" icon={GraduationCap} />
        </SidebarSection>

        <SidebarSection label="Governance">
          <SidebarNavItem to="/governance" label="Constitution" icon={Shield} />
          <SidebarNavItem to="/ecosystem" label="Ecosystem" icon={Globe} />
          <SidebarNavItem to="/economy" label="Economy" icon={Store} />
          <SidebarNavItem to="/expansion" label="Expansion" icon={Expand} />
          <SidebarNavItem to="/stability" label="Stability" icon={HeartPulse} />
          <SidebarNavItem to="/simulation" label="Simulation" icon={FlaskConical} />
        </SidebarSection>

        <SidebarSection label="Company">
          <SidebarNavItem to="/templates" label="Templates" icon={Blocks} />
          <SidebarNavItem to="/org" label="Org" icon={Network} />
          <SidebarNavItem to="/costs" label="Costs" icon={DollarSign} />
          <SidebarNavItem to="/activity" label="Activity" icon={History} />
          <SidebarNavItem to="/company/settings" label="Settings" icon={Settings} />
        </SidebarSection>
      </nav>
    </aside>
  );
}
