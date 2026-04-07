// ---------------------------------------------------------------------------
// Capability Gap Analyzer — detects missing capabilities in the workforce
// ---------------------------------------------------------------------------

import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { eq, and } from "@paperclipai/db";
import { getAllRoles, type RoleDefinition } from "../agents/roleRegistry.js";
import { buildAgentProfile, loadCompanyProfiles } from "../agents/agentProfiles.js";
import pino from "pino";

const logger = pino({ name: "capability-gap-analyzer" });

export interface CapabilityGap {
  taskType: string;
  requiredCapabilities: string[];
  missingCapabilities: string[];
  availableAgents: number;
  capableAgents: number;
  severity: "low" | "medium" | "high" | "critical";
  suggestedRole: string;
  description: string;
}

export interface GapAnalysisResult {
  companyId: string;
  gaps: CapabilityGap[];
  totalCapabilities: number;
  coveredCapabilities: number;
  coverageRate: number;
  analyzedAt: Date;
}

/** Known task types and their required capabilities */
export const TASK_CAPABILITY_MAP: Record<string, string[]> = {
  // Core engineering
  implementation: ["coding", "debugging", "testing"],
  architecture: ["technical_architecture", "system_design"],
  code_review: ["code_review", "coding"],
  testing: ["testing", "quality_assurance"],
  deployment: ["infrastructure", "deployment", "ci_cd"],

  // Product
  product_planning: ["product_planning", "requirements", "prioritization"],
  design: ["ui_design", "ux_research", "prototyping"],

  // Marketing & Sales
  marketing: ["marketing_strategy", "content_creation", "campaign_planning"],
  content: ["content_creation", "brand_management"],
  market_research: ["market_analysis", "research", "data_collection"],
  seo: ["keyword_research", "search_ranking_analysis", "technical_seo"],

  // Finance
  finance: ["financial_planning", "budget_analysis", "cost_optimization"],
  budgeting: ["budget_analysis", "financial_reporting"],

  // Operations
  strategy: ["strategic_planning", "delegation", "goal_setting"],
  oversight: ["company_oversight", "delegation"],

  // Specialized
  localization: ["translation", "regional_seo", "multilingual_content"],
  compliance: ["regulatory_compliance", "legal_review", "risk_assessment"],
  data_analysis: ["data_analysis", "statistical_modeling", "visualization"],
  security: ["security_audit", "vulnerability_assessment", "penetration_testing"],
  customer_support: ["customer_communication", "issue_resolution", "documentation"],
};

/**
 * Analyze capability gaps for a company's workforce.
 */
export async function analyzeCapabilityGaps(
  db: Db,
  companyId: string,
): Promise<GapAnalysisResult> {
  const profiles = await loadCompanyProfiles(db, companyId);

  // Collect all capabilities from active agents
  const companyCaps = new Set<string>();
  for (const profile of profiles) {
    for (const cap of profile.capabilities) {
      companyCaps.add(cap);
    }
  }

  // Analyze gaps across all task types
  const gaps: CapabilityGap[] = [];
  const allRequiredCaps = new Set<string>();

  for (const [taskType, required] of Object.entries(TASK_CAPABILITY_MAP)) {
    for (const cap of required) allRequiredCaps.add(cap);

    const missing = required.filter((c) => !companyCaps.has(c));
    const capableAgents = profiles.filter((p) =>
      required.some((c) => p.capabilities.includes(c)),
    ).length;

    if (missing.length > 0) {
      const missingRatio = missing.length / required.length;
      const severity = missingRatio >= 0.8 ? "critical"
        : missingRatio >= 0.5 ? "high"
        : missingRatio >= 0.3 ? "medium"
        : "low";

      gaps.push({
        taskType,
        requiredCapabilities: required,
        missingCapabilities: missing,
        availableAgents: profiles.length,
        capableAgents,
        severity,
        suggestedRole: suggestRoleForGap(taskType, missing),
        description: `Missing ${missing.length}/${required.length} capabilities for ${taskType}: ${missing.join(", ")}`,
      });
    }
  }

  // Sort by severity
  const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  gaps.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  const coveredCaps = [...allRequiredCaps].filter((c) => companyCaps.has(c)).length;
  const result: GapAnalysisResult = {
    companyId,
    gaps,
    totalCapabilities: allRequiredCaps.size,
    coveredCapabilities: coveredCaps,
    coverageRate: allRequiredCaps.size > 0 ? Math.round((coveredCaps / allRequiredCaps.size) * 100) / 100 : 1,
    analyzedAt: new Date(),
  };

  logger.info(
    { companyId, gaps: gaps.length, coverage: result.coverageRate },
    "Capability gap analysis complete",
  );

  return result;
}

/**
 * Check if a specific task can be handled by the current workforce.
 */
export async function canHandleTask(
  db: Db,
  companyId: string,
  taskType: string,
  requiredCapabilities?: string[],
): Promise<{ capable: boolean; gaps: string[]; capableAgentCount: number }> {
  const profiles = await loadCompanyProfiles(db, companyId);
  const required = requiredCapabilities ?? TASK_CAPABILITY_MAP[taskType] ?? [];

  const companyCaps = new Set<string>();
  for (const p of profiles) {
    for (const c of p.capabilities) companyCaps.add(c);
  }

  const gaps = required.filter((c) => !companyCaps.has(c));
  const capableAgentCount = profiles.filter((p) =>
    required.some((c) => p.capabilities.includes(c)),
  ).length;

  return {
    capable: gaps.length === 0,
    gaps,
    capableAgentCount,
  };
}

/**
 * Detect gaps for a specific goal's tasks.
 */
export async function analyzeGoalGaps(
  db: Db,
  companyId: string,
  taskTypes: string[],
): Promise<CapabilityGap[]> {
  const analysis = await analyzeCapabilityGaps(db, companyId);
  return analysis.gaps.filter((g) => taskTypes.includes(g.taskType));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function suggestRoleForGap(taskType: string, missingCaps: string[]): string {
  const roleMap: Record<string, string> = {
    localization: "localization_specialist",
    compliance: "compliance_officer",
    data_analysis: "data_analyst",
    security: "security_engineer",
    customer_support: "customer_success_agent",
    seo: "seo_specialist",
    deployment: "devops",
    testing: "qa",
    design: "designer",
    marketing: "cmo",
    content: "content_writer",
    market_research: "researcher",
    finance: "cfo",
    architecture: "cto",
    strategy: "ceo",
  };
  return roleMap[taskType] ?? `${taskType}_specialist`;
}
