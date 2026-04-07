export const queryKeys = {
  companies: {
    all: ["companies"] as const,
    detail: (id: string) => ["companies", id] as const,
    stats: ["companies", "stats"] as const,
  },
  agents: {
    list: (companyId: string) => ["agents", companyId] as const,
    detail: (id: string) => ["agents", "detail", id] as const,
    runtimeState: (id: string) => ["agents", "runtime-state", id] as const,
    taskSessions: (id: string) => ["agents", "task-sessions", id] as const,
    keys: (agentId: string) => ["agents", "keys", agentId] as const,
    configRevisions: (agentId: string) => ["agents", "config-revisions", agentId] as const,
  },
  issues: {
    list: (companyId: string) => ["issues", companyId] as const,
    search: (companyId: string, q: string, projectId?: string) =>
      ["issues", companyId, "search", q, projectId ?? "__all-projects__"] as const,
    listAssignedToMe: (companyId: string) => ["issues", companyId, "assigned-to-me"] as const,
    labels: (companyId: string) => ["issues", companyId, "labels"] as const,
    listByProject: (companyId: string, projectId: string) =>
      ["issues", companyId, "project", projectId] as const,
    detail: (id: string) => ["issues", "detail", id] as const,
    comments: (issueId: string) => ["issues", "comments", issueId] as const,
    attachments: (issueId: string) => ["issues", "attachments", issueId] as const,
    artifacts: (issueId: string) => ["issues", "artifacts", issueId] as const,
    activity: (issueId: string) => ["issues", "activity", issueId] as const,
    runs: (issueId: string) => ["issues", "runs", issueId] as const,
    approvals: (issueId: string) => ["issues", "approvals", issueId] as const,
    liveRuns: (issueId: string) => ["issues", "live-runs", issueId] as const,
    activeRun: (issueId: string) => ["issues", "active-run", issueId] as const,
  },
  projects: {
    list: (companyId: string) => ["projects", companyId] as const,
    detail: (id: string) => ["projects", "detail", id] as const,
  },
  goals: {
    list: (companyId: string) => ["goals", companyId] as const,
    detail: (id: string) => ["goals", "detail", id] as const,
  },
  approvals: {
    list: (companyId: string, status?: string) =>
      ["approvals", companyId, status] as const,
    detail: (approvalId: string) => ["approvals", "detail", approvalId] as const,
    comments: (approvalId: string) => ["approvals", "comments", approvalId] as const,
    issues: (approvalId: string) => ["approvals", "issues", approvalId] as const,
  },
  access: {
    joinRequests: (companyId: string, status: string = "pending_approval") =>
      ["access", "join-requests", companyId, status] as const,
    invite: (token: string) => ["access", "invite", token] as const,
  },
  auth: {
    session: ["auth", "session"] as const,
  },
  health: ["health"] as const,
  secrets: {
    list: (companyId: string) => ["secrets", companyId] as const,
    providers: (companyId: string) => ["secret-providers", companyId] as const,
  },
  dashboard: (companyId: string) => ["dashboard", companyId] as const,
  sidebarBadges: (companyId: string) => ["sidebar-badges", companyId] as const,
  activity: (companyId: string) => ["activity", companyId] as const,
  costs: (companyId: string, from?: string, to?: string) =>
    ["costs", companyId, from, to] as const,
  heartbeats: (companyId: string, agentId?: string) =>
    ["heartbeats", companyId, agentId] as const,
  liveRuns: (companyId: string) => ["live-runs", companyId] as const,
  runIssues: (runId: string) => ["run-issues", runId] as const,
  org: (companyId: string) => ["org", companyId] as const,
  templates: {
    all: ["templates"] as const,
    detail: (id: string) => ["templates", id] as const,
  },
  workflows: {
    list: (companyId: string) => ["workflows", companyId] as const,
    runs: (companyId: string) => ["workflow-runs", companyId] as const,
  },
  memories: {
    list: (companyId: string) => ["memories", companyId] as const,
    search: (companyId: string, q: string) => ["memories", companyId, "search", q] as const,
  },
  strategy: {
    plans: (companyId: string) => ["strategy-plans", companyId] as const,
  },
  messages: {
    list: (companyId: string) => ["messages", companyId] as const,
    inbox: (companyId: string, agentId: string) => ["messages", companyId, "inbox", agentId] as const,
  },
  aiDashboard: (companyId: string) => ["ai-dashboard", companyId] as const,
  aiGoalMemory: (companyId: string, goalId: string) =>
    ["ai-dashboard", companyId, "goal-memory", goalId] as const,
  ecosystem: {
    opportunities: (companyId: string) => ["ecosystem", companyId, "opportunities"] as const,
    status: ["ecosystem", "status"] as const,
    limits: ["ecosystem", "limits"] as const,
    requests: (companyId: string) => ["ecosystem", companyId, "requests"] as const,
  },
  economy: {
    services: ["economy", "services"] as const,
    serviceStats: ["economy", "service-stats"] as const,
    companyServices: (companyId: string) => ["economy", companyId, "services"] as const,
    contracts: ["economy", "contracts"] as const,
    companyContracts: (companyId: string) => ["economy", companyId, "contracts"] as const,
    analysis: ["economy", "analysis"] as const,
    companyPerformance: (companyId: string) => ["economy", companyId, "performance"] as const,
  },
  learning: {
    records: (companyId: string) => ["learning", companyId, "records"] as const,
    performance: (companyId: string) => ["learning", companyId, "performance"] as const,
    improvements: (companyId: string) => ["learning", companyId, "improvements"] as const,
  },
  expansion: {
    gaps: (companyId: string) => ["expansion", companyId, "gaps"] as const,
    requests: (companyId: string) => ["expansion", companyId, "requests"] as const,
    limits: (companyId: string) => ["expansion", companyId, "limits"] as const,
  },
  stability: {
    assessment: ["stability", "assessment"] as const,
    canExpand: ["stability", "can-expand"] as const,
    events: ["stability", "events"] as const,
    history: ["stability", "history"] as const,
    thresholds: ["stability", "thresholds"] as const,
    limits: ["stability", "limits"] as const,
  },
  simulation: {
    runs: (companyId: string) => ["simulation", companyId, "runs"] as const,
    run: (companyId: string, runId: string) => ["simulation", companyId, "run", runId] as const,
    scenarios: (companyId: string) => ["simulation", companyId, "scenarios"] as const,
  },
  governance: {
    dashboard: ["governance", "dashboard"] as const,
    limits: ["governance", "limits"] as const,
    goalContainment: (companyId: string) => ["governance", companyId, "goal-containment"] as const,
    rules: (companyId: string) => ["governance", companyId, "rules"] as const,
    knowledge: (companyId: string) => ["governance", companyId, "knowledge"] as const,
    playbooks: (companyId: string) => ["governance", companyId, "playbooks"] as const,
  },
  billing: {
    revenue: (companyId: string, windowMinutes = 30 * 24 * 60) =>
      ["billing", companyId, "revenue", windowMinutes] as const,
    finance: (companyId: string) => ["billing", companyId, "finance"] as const,
  },
};
