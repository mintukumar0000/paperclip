import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { governanceApi } from "../api/governance";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import {
  Shield,
  Scale,
  BookOpen,
  ScrollText,
  Plus,
  Target,
  AlertTriangle,
  CheckCircle,
  Trash2,
  Play,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Tab type
// ---------------------------------------------------------------------------
type Tab = "constitution" | "knowledge" | "playbooks" | "containment" | "limits";

export function Governance() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>("constitution");

  useEffect(() => {
    setBreadcrumbs([{ label: "Governance" }]);
  }, [setBreadcrumbs]);

  // Data queries
  const { data: rules, isLoading: loadingRules } = useQuery({
    queryKey: queryKeys.governance.rules(selectedCompanyId!),
    queryFn: () => governanceApi.listRules(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: knowledge, isLoading: loadingKnowledge } = useQuery({
    queryKey: queryKeys.governance.knowledge(selectedCompanyId!),
    queryFn: () => governanceApi.listKnowledge(selectedCompanyId!),
    enabled: !!selectedCompanyId && tab === "knowledge",
  });

  const { data: playbooks, isLoading: loadingPlaybooks } = useQuery({
    queryKey: queryKeys.governance.playbooks(selectedCompanyId!),
    queryFn: () => governanceApi.listPlaybooks(selectedCompanyId!),
    enabled: !!selectedCompanyId && tab === "playbooks",
  });

  const { data: containment, isLoading: loadingContainment } = useQuery({
    queryKey: queryKeys.governance.goalContainment(selectedCompanyId!),
    queryFn: () => governanceApi.goalContainment(selectedCompanyId!),
    enabled: !!selectedCompanyId && tab === "containment",
  });

  const { data: limits } = useQuery({
    queryKey: queryKeys.governance.limits,
    queryFn: () => governanceApi.limits(),
    enabled: tab === "limits",
  });

  // Mutations
  const [showRuleForm, setShowRuleForm] = useState(false);
  const [ruleForm, setRuleForm] = useState({ ruleName: "", ruleType: "economic", ruleDefinition: "", severity: "blocking", description: "" });

  const createRuleMutation = useMutation({
    mutationFn: () => governanceApi.createRule(selectedCompanyId!, { ...ruleForm, active: true }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.governance.rules(selectedCompanyId!) });
      setShowRuleForm(false);
      setRuleForm({ ruleName: "", ruleType: "economic", ruleDefinition: "", severity: "blocking", description: "" });
    },
  });

  const deleteRuleMutation = useMutation({
    mutationFn: (ruleId: string) => governanceApi.deleteRule(selectedCompanyId!, ruleId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.governance.rules(selectedCompanyId!) });
    },
  });

  const [showKnowledgeForm, setShowKnowledgeForm] = useState(false);
  const [knowledgeForm, setKnowledgeForm] = useState({ title: "", category: "standard", content: "" });

  const createKnowledgeMutation = useMutation({
    mutationFn: () => governanceApi.createKnowledge(selectedCompanyId!, { ...knowledgeForm, tags: [], status: "draft" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.governance.knowledge(selectedCompanyId!) });
      setShowKnowledgeForm(false);
      setKnowledgeForm({ title: "", category: "standard", content: "" });
    },
  });

  const approveKnowledgeMutation = useMutation({
    mutationFn: (id: string) => governanceApi.approveKnowledge(selectedCompanyId!, id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.governance.knowledge(selectedCompanyId!) });
    },
  });

  const [showPlaybookForm, setShowPlaybookForm] = useState(false);
  const [playbookForm, setPlaybookForm] = useState({ title: "", description: "", category: "general", steps: "[]" });

  const createPlaybookMutation = useMutation({
    mutationFn: () => {
      let steps: Array<{ order: number; title: string; description: string }> = [];
      try { steps = JSON.parse(playbookForm.steps); } catch { /* empty */ }
      return governanceApi.createPlaybook(selectedCompanyId!, { ...playbookForm, steps, active: true });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.governance.playbooks(selectedCompanyId!) });
      setShowPlaybookForm(false);
      setPlaybookForm({ title: "", description: "", category: "general", steps: "[]" });
    },
  });

  const applyPlaybookMutation = useMutation({
    mutationFn: (id: string) => governanceApi.applyPlaybook(selectedCompanyId!, id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.governance.playbooks(selectedCompanyId!) });
    },
  });

  if (!selectedCompanyId) return <EmptyState icon={Shield} message="Select a company to view governance." />;

  const tabs: { key: Tab; label: string; icon: React.ReactNode }[] = [
    { key: "constitution", label: "Constitution", icon: <Scale className="h-3.5 w-3.5" /> },
    { key: "knowledge", label: "Knowledge", icon: <BookOpen className="h-3.5 w-3.5" /> },
    { key: "playbooks", label: "Playbooks", icon: <ScrollText className="h-3.5 w-3.5" /> },
    { key: "containment", label: "Goal Containment", icon: <Target className="h-3.5 w-3.5" /> },
    { key: "limits", label: "Autonomy Limits", icon: <Shield className="h-3.5 w-3.5" /> },
  ];

  return (
    <div className="space-y-6">
      {/* Tab bar */}
      <div className="flex items-center gap-1 border-b border-border">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
              tab === t.key
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {/* ================================================================= */}
      {/* TAB: Constitution (Governance Rules)                              */}
      {/* ================================================================= */}
      {tab === "constitution" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">Constitutional Rules</h2>
            <Button size="sm" variant="outline" onClick={() => setShowRuleForm(!showRuleForm)}>
              <Plus className="h-3.5 w-3.5 mr-1" /> New Rule
            </Button>
          </div>

          {showRuleForm && (
            <div className="rounded-lg border border-primary/30 bg-card p-4 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <input
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  placeholder="Rule name"
                  value={ruleForm.ruleName}
                  onChange={(e) => setRuleForm({ ...ruleForm, ruleName: e.target.value })}
                />
                <select
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  value={ruleForm.ruleType}
                  onChange={(e) => setRuleForm({ ...ruleForm, ruleType: e.target.value })}
                >
                  <option value="economic">Economic</option>
                  <option value="ethical">Ethical</option>
                  <option value="strategic">Strategic</option>
                  <option value="safety">Safety</option>
                  <option value="operational">Operational</option>
                </select>
              </div>
              <input
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                placeholder="Rule definition (e.g., company_budget <= ecosystem_budget * 0.20)"
                value={ruleForm.ruleDefinition}
                onChange={(e) => setRuleForm({ ...ruleForm, ruleDefinition: e.target.value })}
              />
              <input
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                placeholder="Description"
                value={ruleForm.description}
                onChange={(e) => setRuleForm({ ...ruleForm, description: e.target.value })}
              />
              <div className="flex items-center gap-2">
                <select
                  className="rounded-md border border-border bg-background px-3 py-2 text-sm"
                  value={ruleForm.severity}
                  onChange={(e) => setRuleForm({ ...ruleForm, severity: e.target.value })}
                >
                  <option value="blocking">Blocking</option>
                  <option value="warning">Warning</option>
                  <option value="advisory">Advisory</option>
                </select>
                <Button
                  size="sm"
                  onClick={() => createRuleMutation.mutate()}
                  disabled={!ruleForm.ruleName || !ruleForm.ruleDefinition || createRuleMutation.isPending}
                >
                  {createRuleMutation.isPending ? "Creating..." : "Create Rule"}
                </Button>
              </div>
            </div>
          )}

          {loadingRules ? <PageSkeleton variant="list" /> : (!rules || rules.length === 0) ? (
            <EmptyState icon={Scale} message="No constitutional rules defined. Create your first rule." />
          ) : (
            <div className="space-y-2">
              {rules.map((rule) => (
                <div key={rule.id} className="rounded-lg border border-border bg-card p-3">
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
                        rule.ruleType === "safety" ? "bg-red-500/10 text-red-500" :
                        rule.ruleType === "economic" ? "bg-green-500/10 text-green-500" :
                        rule.ruleType === "ethical" ? "bg-purple-500/10 text-purple-500" :
                        rule.ruleType === "strategic" ? "bg-blue-500/10 text-blue-500" :
                        "bg-muted text-muted-foreground"
                      }`}>{rule.ruleType}</span>
                      <span className="text-sm font-medium text-foreground">{rule.ruleName}</span>
                      {rule.severity === "blocking" && <AlertTriangle className="h-3 w-3 text-red-500" />}
                    </div>
                    <div className="flex items-center gap-1">
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
                        rule.active ? "bg-green-500/10 text-green-500" : "bg-muted text-muted-foreground"
                      }`}>{rule.active ? "active" : "inactive"}</span>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 w-6 p-0 text-muted-foreground hover:text-red-500"
                        onClick={() => deleteRuleMutation.mutate(rule.id)}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                  <p className="text-xs font-mono text-muted-foreground bg-muted/30 rounded px-2 py-1 mb-1">{rule.ruleDefinition}</p>
                  {rule.description && <p className="text-xs text-muted-foreground">{rule.description}</p>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ================================================================= */}
      {/* TAB: Knowledge (Institutional Knowledge)                          */}
      {/* ================================================================= */}
      {tab === "knowledge" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">Institutional Knowledge</h2>
            <Button size="sm" variant="outline" onClick={() => setShowKnowledgeForm(!showKnowledgeForm)}>
              <Plus className="h-3.5 w-3.5 mr-1" /> Add Knowledge
            </Button>
          </div>

          {showKnowledgeForm && (
            <div className="rounded-lg border border-primary/30 bg-card p-4 space-y-3">
              <input
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                placeholder="Title"
                value={knowledgeForm.title}
                onChange={(e) => setKnowledgeForm({ ...knowledgeForm, title: e.target.value })}
              />
              <select
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                value={knowledgeForm.category}
                onChange={(e) => setKnowledgeForm({ ...knowledgeForm, category: e.target.value })}
              >
                <option value="standard">Coding Standard</option>
                <option value="strategy">Strategy</option>
                <option value="deployment">Deployment Procedure</option>
                <option value="marketing">Marketing</option>
                <option value="vendor">Vendor Relationship</option>
                <option value="market_insight">Market Insight</option>
              </select>
              <textarea
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm min-h-[80px]"
                placeholder="Knowledge content..."
                value={knowledgeForm.content}
                onChange={(e) => setKnowledgeForm({ ...knowledgeForm, content: e.target.value })}
              />
              <Button
                size="sm"
                onClick={() => createKnowledgeMutation.mutate()}
                disabled={!knowledgeForm.title || !knowledgeForm.content || createKnowledgeMutation.isPending}
              >
                {createKnowledgeMutation.isPending ? "Saving..." : "Save"}
              </Button>
            </div>
          )}

          {loadingKnowledge ? <PageSkeleton variant="list" /> : (!knowledge || knowledge.length === 0) ? (
            <EmptyState icon={BookOpen} message="No institutional knowledge recorded yet." />
          ) : (
            <div className="space-y-2">
              {knowledge.map((k) => (
                <div key={k.id} className="rounded-lg border border-border bg-card p-3">
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-foreground">{k.title}</span>
                      <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium bg-muted text-muted-foreground">{k.category}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
                        k.status === "approved" ? "bg-green-500/10 text-green-500" : "bg-yellow-500/10 text-yellow-500"
                      }`}>{k.status}</span>
                      {k.status === "draft" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-xs text-green-500 hover:text-green-400"
                          onClick={() => approveKnowledgeMutation.mutate(k.id)}
                        >
                          <CheckCircle className="h-3 w-3 mr-1" /> Approve
                        </Button>
                      )}
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground whitespace-pre-wrap">{k.content}</p>
                  <p className="text-xs text-muted-foreground mt-1">{new Date(k.createdAt).toLocaleDateString()}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ================================================================= */}
      {/* TAB: Playbooks                                                    */}
      {/* ================================================================= */}
      {tab === "playbooks" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">Organizational Playbooks</h2>
            <Button size="sm" variant="outline" onClick={() => setShowPlaybookForm(!showPlaybookForm)}>
              <Plus className="h-3.5 w-3.5 mr-1" /> New Playbook
            </Button>
          </div>

          {showPlaybookForm && (
            <div className="rounded-lg border border-primary/30 bg-card p-4 space-y-3">
              <input
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                placeholder="Playbook title"
                value={playbookForm.title}
                onChange={(e) => setPlaybookForm({ ...playbookForm, title: e.target.value })}
              />
              <input
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                placeholder="Description"
                value={playbookForm.description}
                onChange={(e) => setPlaybookForm({ ...playbookForm, description: e.target.value })}
              />
              <select
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                value={playbookForm.category}
                onChange={(e) => setPlaybookForm({ ...playbookForm, category: e.target.value })}
              >
                <option value="general">General</option>
                <option value="product_launch">Product Launch</option>
                <option value="infrastructure">Infrastructure</option>
                <option value="marketing">Marketing</option>
                <option value="support">Customer Support</option>
                <option value="onboarding">Onboarding</option>
              </select>
              <textarea
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm min-h-[80px] font-mono"
                placeholder={'Steps (JSON array):\n[{"order":1,"title":"Step 1","description":"..."}]'}
                value={playbookForm.steps}
                onChange={(e) => setPlaybookForm({ ...playbookForm, steps: e.target.value })}
              />
              <Button
                size="sm"
                onClick={() => createPlaybookMutation.mutate()}
                disabled={!playbookForm.title || createPlaybookMutation.isPending}
              >
                {createPlaybookMutation.isPending ? "Creating..." : "Create Playbook"}
              </Button>
            </div>
          )}

          {loadingPlaybooks ? <PageSkeleton variant="list" /> : (!playbooks || playbooks.length === 0) ? (
            <EmptyState icon={ScrollText} message="No playbooks defined. Create your first organizational playbook." />
          ) : (
            <div className="space-y-2">
              {playbooks.map((pb) => (
                <div key={pb.id} className="rounded-lg border border-border bg-card p-3">
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-foreground">{pb.title}</span>
                      <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium bg-muted text-muted-foreground">{pb.category}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">Applied {pb.timesApplied}x</span>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-xs"
                        onClick={() => applyPlaybookMutation.mutate(pb.id)}
                        disabled={applyPlaybookMutation.isPending}
                      >
                        <Play className="h-3 w-3 mr-1" /> Apply
                      </Button>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground mb-2">{pb.description}</p>
                  {pb.steps && pb.steps.length > 0 && (
                    <div className="bg-muted/30 rounded p-2 space-y-1">
                      {pb.steps.map((step, i) => (
                        <div key={i} className="flex items-start gap-2 text-xs">
                          <span className="font-mono text-muted-foreground shrink-0">{step.order}.</span>
                          <div>
                            <span className="text-foreground font-medium">{step.title}</span>
                            <span className="text-muted-foreground ml-1">— {step.description}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ================================================================= */}
      {/* TAB: Goal Containment                                             */}
      {/* ================================================================= */}
      {tab === "containment" && (
        <div className="space-y-4">
          <h2 className="text-sm font-semibold text-foreground">Goal Containment (RGA Prevention)</h2>
          {loadingContainment ? <PageSkeleton variant="list" /> : !containment ? (
            <EmptyState icon={Target} message="No containment data available." />
          ) : (
            <>
              <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-4">
                <div className="rounded-lg border border-border bg-card p-4 text-center">
                  <div className="text-2xl font-bold text-foreground">{containment.activeGoals}</div>
                  <div className="text-xs text-muted-foreground">Active Goals</div>
                  <div className="text-xs text-muted-foreground">max {containment.maxActiveGoals}</div>
                </div>
                <div className="rounded-lg border border-border bg-card p-4 text-center">
                  <div className="text-2xl font-bold text-foreground">{containment.totalGoals}</div>
                  <div className="text-xs text-muted-foreground">Total Goals</div>
                </div>
                <div className="rounded-lg border border-border bg-card p-4 text-center">
                  <div className="text-2xl font-bold text-foreground">{containment.deepestGoalDepth}</div>
                  <div className="text-xs text-muted-foreground">Deepest Depth</div>
                  <div className="text-xs text-muted-foreground">max {containment.maxDepth}</div>
                </div>
                <div className="rounded-lg border border-border bg-card p-4 text-center">
                  <div className="text-2xl font-bold text-foreground">{containment.maxTasksPerPlanCycle}</div>
                  <div className="text-xs text-muted-foreground">Tasks/Cycle Cap</div>
                </div>
              </div>

              {/* Budget bar */}
              <div className="rounded-lg border border-border bg-card p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-muted-foreground">Goal Budget Usage</span>
                  <span className="text-xs font-mono text-foreground">
                    {containment.activeGoals}/{containment.maxActiveGoals}
                  </span>
                </div>
                <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full ${
                      (containment.activeGoals / containment.maxActiveGoals) > 0.85 ? "bg-red-400" :
                      (containment.activeGoals / containment.maxActiveGoals) > 0.6 ? "bg-yellow-400" : "bg-green-400"
                    }`}
                    style={{ width: `${Math.min((containment.activeGoals / containment.maxActiveGoals) * 100, 100)}%` }}
                  />
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* ================================================================= */}
      {/* TAB: Autonomy Limits                                              */}
      {/* ================================================================= */}
      {tab === "limits" && (
        <div className="space-y-4">
          <h2 className="text-sm font-semibold text-foreground">Global Autonomy Limits</h2>
          {!limits ? <PageSkeleton variant="list" /> : (
            <div className="rounded-lg border border-border overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-accent/20 text-muted-foreground">
                    <th className="text-left px-3 py-2 font-medium">Limit</th>
                    <th className="text-right px-3 py-2 font-medium">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(limits).map(([key, value]) => (
                    <tr key={key} className="border-t border-border hover:bg-accent/50">
                      <td className="px-3 py-2 font-mono text-foreground">{key}</td>
                      <td className="px-3 py-2 text-right font-mono text-foreground">{String(value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
