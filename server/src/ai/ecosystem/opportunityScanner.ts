// ---------------------------------------------------------------------------
// Opportunity Scanner — discovers potential business opportunities
// ---------------------------------------------------------------------------

import type { Db } from "@paperclipai/db";
import { companies, agents } from "@paperclipai/db";
import { eq, sql } from "@paperclipai/db";
import { loadCompanyProfiles } from "../agents/agentProfiles.js";
import { analyzeCapabilityGaps } from "../expansion/capabilityGapAnalyzer.js";
import pino from "pino";
import { getAutonomyLimits } from "../governance/autonomyLimits.js";

const logger = pino({ name: "opportunity-scanner" });

export interface Opportunity {
  id: string;
  title: string;
  description: string;
  sourceType: OpportunitySource;
  marketCategory: string;
  potentialRevenue: "low" | "medium" | "high";
  confidence: number; // 0–1
  suggestedProduct: string;
  targetMarket: string;
  discoveredAt: string;
  metadata: Record<string, unknown>;
}

export type OpportunitySource =
  | "capability_gap"
  | "market_trend"
  | "customer_request"
  | "internal_need"
  | "technology_emergence";

export interface ScanResult {
  scannedAt: string;
  sourceCompanyId: string | null;
  opportunities: Opportunity[];
  totalScanned: number;
}

/** Pre-defined market opportunity templates */
export const MARKET_OPPORTUNITIES: Record<
  string,
  Omit<Opportunity, "id" | "discoveredAt" | "metadata">
> = {
  ai_customer_support: {
    title: "AI Customer Support SaaS",
    description: "Automated customer support platform using AI agents for ticket resolution, chat, and FAQ",
    sourceType: "market_trend",
    marketCategory: "customer_support",
    potentialRevenue: "high",
    confidence: 0.85,
    suggestedProduct: "Automated support platform",
    targetMarket: "SaaS startups",
  },
  seo_automation: {
    title: "SEO Automation Platform",
    description: "AI-driven SEO optimization including keyword research, content optimization, and rank tracking",
    sourceType: "capability_gap",
    marketCategory: "marketing_tech",
    potentialRevenue: "medium",
    confidence: 0.75,
    suggestedProduct: "SEO automation tools",
    targetMarket: "Digital marketing teams",
  },
  code_review_service: {
    title: "AI Code Review Service",
    description: "Automated code review and quality assurance platform for engineering teams",
    sourceType: "technology_emergence",
    marketCategory: "developer_tools",
    potentialRevenue: "high",
    confidence: 0.8,
    suggestedProduct: "Code review automation",
    targetMarket: "Software engineering teams",
  },
  data_analytics_platform: {
    title: "AI Data Analytics Platform",
    description: "Self-service analytics platform with AI-powered insights and visualization",
    sourceType: "market_trend",
    marketCategory: "data_analytics",
    potentialRevenue: "high",
    confidence: 0.7,
    suggestedProduct: "Analytics dashboard platform",
    targetMarket: "Business intelligence teams",
  },
  content_generation: {
    title: "AI Content Generation Studio",
    description: "Multi-format content creation platform for blogs, social media, and marketing materials",
    sourceType: "market_trend",
    marketCategory: "content_creation",
    potentialRevenue: "medium",
    confidence: 0.8,
    suggestedProduct: "Content generation platform",
    targetMarket: "Marketing teams and agencies",
  },
  compliance_automation: {
    title: "Compliance Automation SaaS",
    description: "Regulatory compliance monitoring and reporting platform",
    sourceType: "internal_need",
    marketCategory: "legal_tech",
    potentialRevenue: "medium",
    confidence: 0.65,
    suggestedProduct: "Compliance monitoring tools",
    targetMarket: "Regulated industries",
  },
  security_audit_platform: {
    title: "AI Security Audit Platform",
    description: "Continuous security assessment and vulnerability management",
    sourceType: "technology_emergence",
    marketCategory: "cybersecurity",
    potentialRevenue: "high",
    confidence: 0.75,
    suggestedProduct: "Security audit automation",
    targetMarket: "Enterprise IT teams",
  },
};

let opportunityCounter = 0;

function generateId(): string {
  opportunityCounter += 1;
  return `opp_${Date.now()}_${opportunityCounter}`;
}

/**
 * Scan for opportunities based on capability gaps in an existing company.
 */
export async function scanFromCompanyGaps(
  db: Db,
  companyId: string,
): Promise<Opportunity[]> {
  const analysis = await analyzeCapabilityGaps(db, companyId);
  const opportunities: Opportunity[] = [];

  for (const gap of analysis.gaps) {
    if (gap.severity !== "critical" && gap.severity !== "high") continue;

    // Map capability gaps to potential business opportunities
    const marketKey = GAP_TO_MARKET[gap.taskType];
    if (!marketKey) continue;

    const template = MARKET_OPPORTUNITIES[marketKey];
    if (!template) continue;

    opportunities.push({
      ...template,
      id: generateId(),
      sourceType: "capability_gap",
      confidence: Math.min(template.confidence + 0.05, 1.0),
      discoveredAt: new Date().toISOString(),
      metadata: { sourceGap: gap.taskType, severity: gap.severity, companyId },
    });
  }

  return opportunities;
}

/** Maps task-type gaps to market opportunity keys */
export const GAP_TO_MARKET: Record<string, string> = {
  customer_support: "ai_customer_support",
  seo: "seo_automation",
  code_review: "code_review_service",
  data_analysis: "data_analytics_platform",
  content: "content_generation",
  compliance: "compliance_automation",
  security: "security_audit_platform",
};

/**
 * Scan for market-trend opportunities (template-based discovery).
 */
export function scanMarketTrends(): Opportunity[] {
  return Object.values(MARKET_OPPORTUNITIES)
    .filter((t) => t.sourceType === "market_trend")
    .map((t) => ({
      ...t,
      id: generateId(),
      discoveredAt: new Date().toISOString(),
      metadata: {},
    }));
}

/**
 * Full ecosystem scan — combines gap-based and market-trend discovery.
 * Optionally anchored to a source company.
 */
export async function scanOpportunities(
  db: Db,
  sourceCompanyId?: string,
): Promise<ScanResult> {
  const opportunities: Opportunity[] = [];

  // 1. Market trend opportunities
  opportunities.push(...scanMarketTrends());

  // 2. Gap-based opportunities from source company
  if (sourceCompanyId) {
    const gapOpps = await scanFromCompanyGaps(db, sourceCompanyId);
    // Deduplicate by title
    const existingTitles = new Set(opportunities.map((o) => o.title));
    for (const opp of gapOpps) {
      if (!existingTitles.has(opp.title)) {
        opportunities.push(opp);
        existingTitles.add(opp.title);
      }
    }
  }

  // 3. List all existing companies to avoid duplicates
  const existingCompanies = await db.select({ name: companies.name }).from(companies);
  const existingNames = new Set(existingCompanies.map((c) => c.name.toLowerCase()));

  // Filter out opportunities that match existing company names
  const filtered = opportunities.filter(
    (o) => !existingNames.has(o.title.toLowerCase()),
  );

  // Sort by confidence descending
  filtered.sort((a, b) => b.confidence - a.confidence);

  // Cap opportunities to goal fan-out limit to prevent unbounded venture proposals
  const maxResults = getAutonomyLimits().maxChildGoals;
  const capped = filtered.slice(0, maxResults);

  logger.info(
    { sourceCompanyId, total: capped.length, scanned: filtered.length },
    "Opportunity scan completed",
  );

  return {
    scannedAt: new Date().toISOString(),
    sourceCompanyId: sourceCompanyId ?? null,
    opportunities: capped,
    totalScanned: Object.keys(MARKET_OPPORTUNITIES).length,
  };
}
