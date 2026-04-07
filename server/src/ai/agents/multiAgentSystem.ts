import type { Db } from "@paperclipai/db";
import { activityLog } from "@paperclipai/db";
import { eq, and, desc } from "@paperclipai/db";
import pino from "pino";
import { routeLLMJSON, type LLMTask } from "../llmRouter.js";
import { buildMemoryContext } from "../../memory/embeddingMemory.js";
import type { SystemMetricSnapshot } from "../feedback/metricsEngine.js";

const logger = pino({ name: "multi-agent-system" });

export type AgentRole = "marketing" | "product" | "pricing" | "growth";

interface AgentDecision {
  action: string;
  reasoning: string;
  priority: "high" | "medium" | "low";
  expectedImpact: string;
}

interface AgentReport {
  role: AgentRole;
  kpis: Record<string, number | string>;
  decisions: AgentDecision[];
  analysis: string;
}

const AGENT_CONFIGS: Record<AgentRole, {
  name: string;
  kpis: string[];
  systemPrompt: string;
  llmTask: LLMTask;
}> = {
  marketing: {
    name: "Marketing Agent",
    kpis: ["traffic", "signups", "content_posts", "reply_engagement"],
    systemPrompt: `You are the Marketing Agent. Your job is to increase traffic and signups.

You control:
- Reddit posting strategy (subreddits, timing, angles)
- Twitter/X content
- Reddit reply engagement
- Content distribution

Your KPIs:
- Traffic growth week-over-week
- Signup conversion rate
- Content engagement rate

Analyze the metrics and suggest 2-3 specific marketing actions.`,
    llmTask: "decision",
  },
  product: {
    name: "Product Agent",
    kpis: ["signup_rate", "bounce_rate", "user_feedback"],
    systemPrompt: `You are the Product Agent. Your job is to improve the landing page and user experience.

You control:
- Landing page variants (headlines, CTAs, layout)
- Signup flow optimization
- Email template quality
- Product messaging

Your KPIs:
- Signup rate (visitors → signups)
- Bounce rate
- Email open rate

Analyze the metrics and suggest 2-3 specific product improvements.`,
    llmTask: "decision",
  },
  pricing: {
    name: "Pricing Agent",
    kpis: ["revenue_per_user", "payment_conversion_rate", "average_order_value"],
    systemPrompt: `You are the Pricing Agent. Your job is to maximize revenue per user.

You control:
- Price points ($5/$7/$9/$15/$29)
- Pricing psychology (anchoring, decoy, urgency)
- Tier structure
- Discount strategy

Your KPIs:
- Revenue per user
- Payment conversion rate
- Average order value

Analyze the metrics and suggest 2-3 specific pricing actions.`,
    llmTask: "reasoning",
  },
  growth: {
    name: "Growth Agent",
    kpis: ["revenue_growth", "channel_roi", "customer_acquisition_cost"],
    systemPrompt: `You are the Growth Agent. Your job is to find and scale winning channels.

You control:
- Channel prioritization (Reddit, Twitter, SEO, etc.)
- Budget allocation across channels
- Scaling decisions (when to increase/decrease effort)
- New channel experiments

Your KPIs:
- Revenue growth rate
- ROI per channel
- Customer acquisition cost

Analyze the metrics and suggest 2-3 specific growth actions.`,
    llmTask: "reasoning",
  },
};

export async function runAgentAnalysis(
  db: Db,
  companyId: string,
  role: AgentRole,
  metrics: SystemMetricSnapshot,
): Promise<AgentReport | null> {
  const config = AGENT_CONFIGS[role];

  let memoryContext = "";
  try {
    memoryContext = await buildMemoryContext(db, companyId, `${role} agent performance outcomes`, 5);
  } catch { /* memory unavailable */ }

  const result = await routeLLMJSON<Record<string, unknown>>(config.llmTask, [
    {
      role: "system",
      content: `${config.systemPrompt}

Return JSON:
{
  "analysis": "2-3 sentence assessment of current state",
  "kpis": { "kpi_name": value },
  "decisions": [
    {
      "action": "Specific action to take",
      "reasoning": "Why this matters",
      "priority": "high|medium|low",
      "expected_impact": "What this should improve"
    }
  ]
}`,
    },
    {
      role: "user",
      content: `## Current Metrics
- Traffic: ${metrics.traffic}
- Conversions: ${metrics.conversions}
- Revenue: $${(metrics.revenue / 100).toFixed(2)}
- Conversion Rate: ${metrics.conversion_rate.toFixed(2)}%
- Payment Conversion Rate: ${metrics.payment_conversion_rate.toFixed(2)}%
- Revenue per Visitor: ${metrics.revenue_per_visit.toFixed(2)}c
- Revenue per User: ${metrics.revenue_per_user.toFixed(2)}c
- Bounce Rate: ${metrics.bounce_rate.toFixed(1)}%

${memoryContext ? `\n## Past Performance\n${memoryContext}` : ""}

As the ${config.name}, what are your top 2-3 recommendations?`,
    },
  ]);

  if (!result) return null;

  const decisions: AgentDecision[] = [];
  const rawDecisions = result.decisions as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(rawDecisions)) {
    for (const d of rawDecisions) {
      decisions.push({
        action: String(d.action ?? ""),
        reasoning: String(d.reasoning ?? ""),
        priority: (d.priority as "high" | "medium" | "low") ?? "medium",
        expectedImpact: String(d.expected_impact ?? ""),
      });
    }
  }

  const report: AgentReport = {
    role,
    kpis: (result.kpis as Record<string, number | string>) ?? {},
    decisions,
    analysis: String(result.analysis ?? ""),
  };

  await db.insert(activityLog).values({
    companyId,
    actorType: "system",
    actorId: `agent-${role}`,
    agentId: null,
    runId: null,
    action: `agent.${role}.analysis.completed`,
    entityType: "company",
    entityId: companyId,
    details: {
      role,
      analysis: report.analysis.slice(0, 200),
      decisionCount: decisions.length,
      kpis: report.kpis,
    },
  });

  logger.info({ role, companyId, decisions: decisions.length }, `${config.name} analysis completed`);
  return report;
}

export async function runMultiAgentCycle(
  db: Db,
  companyId: string,
  metrics: SystemMetricSnapshot,
): Promise<AgentReport[]> {
  const roles: AgentRole[] = ["marketing", "product", "pricing", "growth"];
  const reports: AgentReport[] = [];

  for (const role of roles) {
    try {
      const report = await runAgentAnalysis(db, companyId, role, metrics);
      if (report) reports.push(report);
    } catch (err) {
      logger.warn({ err, role }, "Agent analysis failed");
    }
  }

  if (reports.length > 0) {
    await db.insert(activityLog).values({
      companyId,
      actorType: "system",
      actorId: "multi-agent-system",
      agentId: null,
      runId: null,
      action: "agent.multi.cycle.completed",
      entityType: "company",
      entityId: companyId,
      details: {
        agentCount: reports.length,
        totalDecisions: reports.reduce((sum, r) => sum + r.decisions.length, 0),
        roles: reports.map((r) => r.role),
      },
    });
  }

  return reports;
}

let multiAgentInterval: ReturnType<typeof setInterval> | null = null;

export function startMultiAgentSystem(db: Db, intervalMs = 6 * 60 * 60_000): () => void {
  const enabled = (process.env.MULTI_AGENT_ENABLED ?? "true").trim().toLowerCase();
  if (enabled === "false" || enabled === "0") {
    logger.info("Multi-agent system disabled");
    return () => {};
  }

  logger.info({ intervalMs }, "Starting multi-agent system");

  setTimeout(async () => {
    try {
      const { companies } = await import("@paperclipai/db");
      const { getRecentSystemMetricsSnapshot } = await import("../feedback/metricsEngine.js");
      const allCompanies = await db.select({ id: companies.id }).from(companies).limit(3);

      for (const company of allCompanies) {
        const metrics = await getRecentSystemMetricsSnapshot(db, company.id, 4320);
        if (metrics.sample_count < 3) continue;
        await runMultiAgentCycle(db, company.id, metrics);
      }
    } catch (err) {
      logger.error({ err }, "Multi-agent cycle failed");
    }
  }, 5 * 60_000);

  multiAgentInterval = setInterval(async () => {
    try {
      const { companies } = await import("@paperclipai/db");
      const { getRecentSystemMetricsSnapshot } = await import("../feedback/metricsEngine.js");
      const allCompanies = await db.select({ id: companies.id }).from(companies).limit(3);

      for (const company of allCompanies) {
        const metrics = await getRecentSystemMetricsSnapshot(db, company.id, 4320);
        if (metrics.sample_count < 3) continue;
        await runMultiAgentCycle(db, company.id, metrics);
      }
    } catch (err) {
      logger.error({ err }, "Multi-agent cycle failed");
    }
  }, intervalMs);

  return () => {
    if (multiAgentInterval) {
      clearInterval(multiAgentInterval);
      multiAgentInterval = null;
    }
  };
}
