// ---------------------------------------------------------------------------
// Agent Designer — designs new agent role specs to fill capability gaps
// ---------------------------------------------------------------------------

import type { Db } from "@paperclipai/db";
import type { CapabilityGap } from "./capabilityGapAnalyzer.js";
import { getAllRoles, type RoleDefinition } from "../agents/roleRegistry.js";
import { publishEvent } from "../../events/eventPublisher.js";
import pino from "pino";

const logger = pino({ name: "agent-designer" });

export interface AgentDesignSpec {
  role: string;
  title: string;
  capabilities: string[];
  taskTypes: string[];
  canDelegate: boolean;
  canApprove: boolean;
  priority: number;
  department: string;
  reportsTo: string;      // role that this reports to
  budgetCents: number;
  reason: string;
  sourceGaps: string[];    // task types that triggered this
}

export interface DesignResult {
  companyId: string;
  designs: AgentDesignSpec[];
  gapsAddressed: number;
  generatedAt: Date;
}

/** Role templates for common gap-filling agents */
export const ROLE_TEMPLATES: Record<string, Omit<AgentDesignSpec, "reason" | "sourceGaps">> = {
  localization_specialist: {
    role: "localization_specialist",
    title: "Localization Specialist",
    capabilities: ["translation", "regional_seo", "multilingual_content", "cultural_adaptation"],
    taskTypes: ["localization", "translation", "regional_seo"],
    canDelegate: false,
    canApprove: false,
    priority: 6,
    department: "Localization",
    reportsTo: "cmo",
    budgetCents: 500,
  },
  compliance_officer: {
    role: "compliance_officer",
    title: "Compliance Officer",
    capabilities: ["regulatory_compliance", "legal_review", "risk_assessment", "policy_management"],
    taskTypes: ["compliance", "legal_review", "risk_assessment"],
    canDelegate: false,
    canApprove: true,
    priority: 4,
    department: "Legal",
    reportsTo: "ceo",
    budgetCents: 800,
  },
  data_analyst: {
    role: "data_analyst",
    title: "Data Analyst",
    capabilities: ["data_analysis", "statistical_modeling", "visualization", "reporting"],
    taskTypes: ["data_analysis", "reporting", "analytics"],
    canDelegate: false,
    canApprove: false,
    priority: 5,
    department: "Engineering",
    reportsTo: "cto",
    budgetCents: 600,
  },
  security_engineer: {
    role: "security_engineer",
    title: "Security Engineer",
    capabilities: ["security_audit", "vulnerability_assessment", "penetration_testing", "security_monitoring"],
    taskTypes: ["security", "security_audit", "vulnerability_assessment"],
    canDelegate: false,
    canApprove: false,
    priority: 4,
    department: "Engineering",
    reportsTo: "cto",
    budgetCents: 700,
  },
  customer_success_agent: {
    role: "customer_success_agent",
    title: "Customer Success Agent",
    capabilities: ["customer_communication", "issue_resolution", "documentation", "feedback_collection"],
    taskTypes: ["customer_support", "documentation", "feedback"],
    canDelegate: false,
    canApprove: false,
    priority: 6,
    department: "Customer Success",
    reportsTo: "ceo",
    budgetCents: 400,
  },
  seo_specialist: {
    role: "seo_specialist",
    title: "SEO Specialist",
    capabilities: ["keyword_research", "search_ranking_analysis", "technical_seo", "content_optimization"],
    taskTypes: ["seo", "keyword_research", "content_optimization"],
    canDelegate: false,
    canApprove: false,
    priority: 6,
    department: "Marketing",
    reportsTo: "cmo",
    budgetCents: 500,
  },
  content_writer: {
    role: "content_writer",
    title: "Content Writer",
    capabilities: ["content_creation", "copywriting", "blog_writing", "technical_writing"],
    taskTypes: ["content", "copywriting", "blog_writing"],
    canDelegate: false,
    canApprove: false,
    priority: 6,
    department: "Marketing",
    reportsTo: "cmo",
    budgetCents: 400,
  },
};

/**
 * Design agents to fill capability gaps.
 */
export async function designAgents(
  db: Db,
  companyId: string,
  gaps: CapabilityGap[],
): Promise<DesignResult> {
  const designs: AgentDesignSpec[] = [];
  const addressed = new Set<string>();

  for (const gap of gaps) {
    // Skip gaps that don't need new agents (low severity)
    if (gap.severity === "low" && gap.capableAgents > 0) continue;

    const template = ROLE_TEMPLATES[gap.suggestedRole];
    if (template) {
      // Check we haven't already designed this role
      if (designs.some((d) => d.role === template.role)) {
        // Just add the gap to existing design's sourceGaps
        const existing = designs.find((d) => d.role === template.role)!;
        existing.sourceGaps.push(gap.taskType);
        addressed.add(gap.taskType);
        continue;
      }

      designs.push({
        ...template,
        reason: `Fill capability gap: ${gap.description}`,
        sourceGaps: [gap.taskType],
      });
      addressed.add(gap.taskType);
    } else {
      // Generate a custom design from the gap
      designs.push(designFromGap(gap));
      addressed.add(gap.taskType);
    }
  }

  const result: DesignResult = {
    companyId,
    designs,
    gapsAddressed: addressed.size,
    generatedAt: new Date(),
  };

  logger.info(
    { companyId, designs: designs.length, gapsAddressed: addressed.size },
    "Agent designs generated",
  );

  return result;
}

/**
 * Design a single agent from a gap analysis.
 */
export function designFromGap(gap: CapabilityGap): AgentDesignSpec {
  const role = gap.suggestedRole.replace(/[-\s]+/g, "_").toLowerCase();

  return {
    role,
    title: gap.suggestedRole
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase()),
    capabilities: gap.missingCapabilities,
    taskTypes: [gap.taskType],
    canDelegate: false,
    canApprove: false,
    priority: 6,
    department: inferDepartment(gap.taskType),
    reportsTo: inferReportsTo(gap.taskType),
    budgetCents: 500,
    reason: `Fill capability gap: ${gap.description}`,
    sourceGaps: [gap.taskType],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function inferDepartment(taskType: string): string {
  const deptMap: Record<string, string> = {
    implementation: "Engineering",
    architecture: "Engineering",
    code_review: "Engineering",
    testing: "Engineering",
    deployment: "Engineering",
    design: "Product",
    product_planning: "Product",
    marketing: "Marketing",
    content: "Marketing",
    market_research: "Marketing",
    seo: "Marketing",
    finance: "Finance",
    budgeting: "Finance",
    strategy: "Executive",
    oversight: "Executive",
    localization: "Localization",
    compliance: "Legal",
    data_analysis: "Analytics",
    security: "Engineering",
    customer_support: "Customer Success",
  };
  return deptMap[taskType] ?? "General";
}

function inferReportsTo(taskType: string): string {
  const reportMap: Record<string, string> = {
    implementation: "cto",
    architecture: "cto",
    code_review: "cto",
    testing: "cto",
    deployment: "cto",
    design: "cto",
    marketing: "cmo",
    content: "cmo",
    market_research: "cmo",
    seo: "cmo",
    finance: "cfo",
    budgeting: "cfo",
  };
  return reportMap[taskType] ?? "ceo";
}
