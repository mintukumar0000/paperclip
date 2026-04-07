// ---------------------------------------------------------------------------
// Business Designer — transforms opportunities into business models
// ---------------------------------------------------------------------------

import type { Opportunity } from "./opportunityScanner.js";
import pino from "pino";

const logger = pino({ name: "business-designer" });

export interface BusinessModel {
  companyName: string;
  product: string;
  description: string;
  targetMarket: string;
  revenueModel: RevenueModel;
  marketCategory: string;
  initialBudgetCents: number;
  initialAgentRoles: AgentRoleSpec[];
  milestones: Milestone[];
  sourceOpportunity: string; // opportunity ID
  confidence: number;
  designedAt: string;
}

export type RevenueModel = "subscription" | "usage_based" | "marketplace" | "freemium" | "enterprise";

export interface AgentRoleSpec {
  role: string;
  title: string;
  capabilities: string[];
  priority: number;
}

export interface Milestone {
  phase: number;
  title: string;
  description: string;
  targetDays: number;
}

export interface DesignResult {
  opportunity: Opportunity;
  businessModel: BusinessModel;
  feasibilityScore: number; // 0–1
  designedAt: string;
}

/** Maps market categories to revenue models */
const CATEGORY_REVENUE: Record<string, RevenueModel> = {
  customer_support: "subscription",
  marketing_tech: "usage_based",
  developer_tools: "freemium",
  data_analytics: "subscription",
  content_creation: "usage_based",
  legal_tech: "enterprise",
  cybersecurity: "enterprise",
};

/** Default agent roles for a new company */
const DEFAULT_AGENT_ROLES: AgentRoleSpec[] = [
  { role: "ceo", title: "CEO", capabilities: ["strategic_planning", "delegation", "goal_setting"], priority: 1 },
  { role: "engineer", title: "Lead Engineer", capabilities: ["coding", "debugging", "testing", "system_design"], priority: 3 },
  { role: "pm", title: "Product Manager", capabilities: ["product_planning", "requirements", "prioritization"], priority: 4 },
  { role: "designer", title: "Designer", capabilities: ["ui_design", "ux_research"], priority: 5 },
];

/** Category-specific supplementary roles */
const CATEGORY_AGENTS: Record<string, AgentRoleSpec[]> = {
  customer_support: [
    { role: "customer_success", title: "Customer Success Lead", capabilities: ["customer_communication", "issue_resolution"], priority: 4 },
  ],
  marketing_tech: [
    { role: "cmo", title: "CMO", capabilities: ["marketing_strategy", "campaign_planning"], priority: 2 },
    { role: "seo_specialist", title: "SEO Specialist", capabilities: ["keyword_research", "technical_seo"], priority: 6 },
  ],
  developer_tools: [
    { role: "devops", title: "DevOps Engineer", capabilities: ["infrastructure", "deployment", "ci_cd"], priority: 5 },
  ],
  data_analytics: [
    { role: "data_analyst", title: "Data Analyst", capabilities: ["data_analysis", "statistical_modeling", "visualization"], priority: 5 },
  ],
  content_creation: [
    { role: "cmo", title: "CMO", capabilities: ["marketing_strategy", "content_creation"], priority: 2 },
    { role: "content_writer", title: "Content Writer", capabilities: ["content_creation", "brand_management"], priority: 6 },
  ],
  legal_tech: [
    { role: "compliance_officer", title: "Compliance Officer", capabilities: ["regulatory_compliance", "legal_review"], priority: 4 },
  ],
  cybersecurity: [
    { role: "security_engineer", title: "Security Engineer", capabilities: ["security_audit", "vulnerability_assessment"], priority: 4 },
  ],
};

/** Default milestones for new ventures */
const DEFAULT_MILESTONES: Milestone[] = [
  { phase: 1, title: "Build MVP", description: "Core product development and internal testing", targetDays: 14 },
  { phase: 2, title: "Launch Landing Page", description: "Public-facing website and documentation", targetDays: 7 },
  { phase: 3, title: "First Customers", description: "Acquire initial beta customers", targetDays: 21 },
  { phase: 4, title: "Scale Marketing", description: "Growth campaigns and content marketing", targetDays: 30 },
];

/**
 * Generate a company name from an opportunity.
 */
export function generateCompanyName(opportunity: Opportunity): string {
  // Use the opportunity title as a base and shorten it
  const words = opportunity.title.split(/\s+/);
  if (words.length <= 2) return opportunity.title;

  // Try extracting key word + "AI" suffix
  const keyWord = words.find((w) => !["AI", "Platform", "SaaS", "Service", "Automation"].includes(w));
  if (keyWord) return `${keyWord}AI`;
  return words.slice(0, 2).join("");
}

/**
 * Design a business model from an opportunity.
 */
export function designBusiness(opportunity: Opportunity): DesignResult {
  const companyName = generateCompanyName(opportunity);
  const revenueModel = CATEGORY_REVENUE[opportunity.marketCategory] ?? "subscription";

  // Build agent roster: defaults + category-specific
  const agentRoles = [...DEFAULT_AGENT_ROLES];
  const extras = CATEGORY_AGENTS[opportunity.marketCategory] ?? [];
  agentRoles.push(...extras);

  // Budget: scale with revenue potential
  const budgetMap: Record<string, number> = { low: 5000, medium: 8000, high: 12000 };
  const initialBudgetCents = budgetMap[opportunity.potentialRevenue] ?? 8000;

  // Feasibility: based on confidence + revenue potential
  const revScore: Record<string, number> = { low: 0.3, medium: 0.6, high: 0.9 };
  const feasibilityScore = Math.min(
    (opportunity.confidence + (revScore[opportunity.potentialRevenue] ?? 0.5)) / 2,
    1.0,
  );

  const businessModel: BusinessModel = {
    companyName,
    product: opportunity.suggestedProduct,
    description: opportunity.description,
    targetMarket: opportunity.targetMarket,
    revenueModel,
    marketCategory: opportunity.marketCategory,
    initialBudgetCents,
    initialAgentRoles: agentRoles,
    milestones: [...DEFAULT_MILESTONES],
    sourceOpportunity: opportunity.id,
    confidence: opportunity.confidence,
    designedAt: new Date().toISOString(),
  };

  logger.info(
    { companyName, revenueModel, agentCount: agentRoles.length, feasibilityScore },
    "Business model designed",
  );

  return {
    opportunity,
    businessModel,
    feasibilityScore,
    designedAt: new Date().toISOString(),
  };
}

/**
 * Design business models for multiple opportunities.
 */
export function designBusinesses(opportunities: Opportunity[]): DesignResult[] {
  return opportunities.map(designBusiness);
}
