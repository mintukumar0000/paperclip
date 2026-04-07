import type { Db } from "@paperclipai/db";
import { activityLog, eq, desc, and } from "@paperclipai/db";
import pino from "pino";
import { routeLLMJSON, type LLMTask } from "../llmRouter.js";
import { getStrategyState } from "../brain/strategyBrain.js";
import { getSkillsForTask } from "../skills/applySkills.js";
import { buildMemoryContext } from "../../memory/embeddingMemory.js";
import { getRecentSystemMetricsSnapshot, type SystemMetricSnapshot } from "../feedback/metricsEngine.js";
import { executeActions, type ExecutionAction } from "../execution/autonomousExecutor.js";
import { extractSkillsFromRecentPerformance } from "../skills/skillExtractor.js";
import { decayAllSkills } from "../skills/skillStore.js";
import { eventBus } from "../../events/eventBus.js";
import { listScopedCompanyIds } from "../../core/companyScope.js";

const logger = pino({ name: "agent-coordinator" });

interface AgentConfig {
  name: string;
  role: string;
  category: "traffic" | "conversion" | "pricing" | "email" | "strategy" | "ops";
  llmTask: LLMTask;
  description: string;
}

interface AgentDecision {
  action: string;
  key: string;
  priority: "high" | "medium" | "low";
  reasoning: string;
  expectedImpact: string;
  confidence: number;
}

interface AgentOutput {
  agent: string;
  role: string;
  analysis: string;
  decisions: AgentDecision[];
}

const AGENT_TEAM: AgentConfig[] = [
  {
    name: "CEO",
    role: "strategy",
    category: "strategy",
    llmTask: "reasoning",
    description: "Sets strategic direction. Decides what the company should focus on.",
  },
  {
    name: "CMO",
    role: "traffic",
    category: "traffic",
    llmTask: "decision",
    description: "Drives traffic and distribution. Controls Reddit, Twitter, SEO, content.",
  },
  {
    name: "CRO",
    role: "conversion",
    category: "conversion",
    llmTask: "decision",
    description: "Optimizes conversion. Controls landing pages, email sequences, signup flow.",
  },
  {
    name: "CFO",
    role: "pricing",
    category: "pricing",
    llmTask: "reasoning",
    description: "Maximizes revenue per user. Controls pricing, tiers, offers, payment flow.",
  },
];

async function runAgent(
  db: Db,
  companyId: string,
  agent: AgentConfig,
  strategyContext: string,
  metrics: SystemMetricSnapshot,
): Promise<AgentOutput | null> {
  const { skills, promptBlock } = await getSkillsForTask(db, companyId, agent.category);

  let memory = "";
  try {
    memory = await buildMemoryContext(db, companyId, `${agent.role} performance outcomes`, 5);
  } catch { /* memory unavailable */ }

  const result = await routeLLMJSON<{
    analysis?: string;
    decisions?: Array<{
      action?: string;
      key?: string;
      priority?: string;
      reasoning?: string;
      expected_impact?: string;
      confidence?: number;
    }>;
  }>(agent.llmTask, [
    {
      role: "system",
      content: `You are the ${agent.name} (${agent.description}) of an autonomous startup.

${strategyContext}

${promptBlock}

Analyze the metrics and generate 2-3 concrete, actionable decisions.

Return JSON:
{
  "analysis": "2-3 sentence assessment of current state from your perspective",
  "decisions": [
    {
      "action": "Human-readable description of what to do",
      "key": "machine_key_for_executor",
      "priority": "high|medium|low",
      "reasoning": "Why this matters NOW",
      "expected_impact": "What metric this improves and by how much",
      "confidence": 0.0-1.0
    }
  ]
}

Valid keys for executor:
- increase_content_output (post more to Reddit/Twitter)
- auto_scale_distribution (increase posting frequency)
- improve_landing_page (generate new landing variants)
- run_pricing_experiment (test different price points)
- email_sequence_optimization (improve email drip)
- generate_seo_content (create blog posts)
- increase_reddit_frequency (more Reddit activity)
- audience_repositioning_test (test new audiences)

Be SPECIFIC and set confidence based on how sure you are this will work.`,
    },
    {
      role: "user",
      content: `## Current Metrics
- Traffic: ${metrics.traffic}
- Conversions: ${metrics.conversions}
- Revenue: $${(metrics.revenue / 100).toFixed(2)}
- Conversion Rate: ${metrics.conversion_rate.toFixed(2)}%
- Payment Conversion: ${metrics.payment_conversion_rate.toFixed(2)}%
- Revenue/Visitor: ${metrics.revenue_per_visit.toFixed(2)}c
- Revenue/User: ${metrics.revenue_per_user.toFixed(2)}c
- Bounce Rate: ${metrics.bounce_rate.toFixed(1)}%

${memory ? `## Memory\n${memory}` : ""}

As the ${agent.name}, what are your top decisions?`,
    },
  ]);

  if (!result) return null;

  const decisions: AgentDecision[] = [];
  if (Array.isArray(result.decisions)) {
    for (const d of result.decisions) {
      decisions.push({
        action: String(d.action ?? ""),
        key: String(d.key ?? "unknown"),
        priority: (d.priority as "high" | "medium" | "low") ?? "medium",
        reasoning: String(d.reasoning ?? ""),
        expectedImpact: String(d.expected_impact ?? ""),
        confidence: typeof d.confidence === "number" ? Math.max(0, Math.min(1, d.confidence)) : 0.5,
      });
    }
  }

  return {
    agent: agent.name,
    role: agent.role,
    analysis: String(result.analysis ?? ""),
    decisions,
  };
}

function resolveConflicts(outputs: AgentOutput[]): ExecutionAction[] {
  const allDecisions: Array<AgentDecision & { source: string }> = [];

  for (const output of outputs) {
    for (const decision of output.decisions) {
      allDecisions.push({ ...decision, source: output.agent });
    }
  }

  const scored = allDecisions.map((d) => {
    let score = d.confidence;
    if (d.priority === "high") score += 0.3;
    else if (d.priority === "medium") score += 0.15;
    if (d.expectedImpact.toLowerCase().includes("revenue")) score += 0.1;
    if (d.expectedImpact.toLowerCase().includes("conversion")) score += 0.05;
    return { ...d, score };
  });

  scored.sort((a, b) => b.score - a.score);

  const seenKeys = new Set<string>();
  const actions: ExecutionAction[] = [];

  for (const decision of scored) {
    if (seenKeys.has(decision.key)) continue;
    seenKeys.add(decision.key);

    actions.push({
      key: decision.key,
      type: decision.key,
      reasoning: `[${decision.source}] ${decision.reasoning}`,
      priority: decision.priority,
      expectedImpact: decision.expectedImpact,
      confidence: decision.confidence,
      source: decision.source,
    });

    if (actions.length >= 5) break;
  }

  return actions;
}

export async function runCoordinatedCycle(
  db: Db,
  companyId: string,
): Promise<void> {
  const metrics = await getRecentSystemMetricsSnapshot(db, companyId, 4320);
  if (metrics.sample_count < 2) return;

  const strategyState = await getStrategyState(db, companyId);
  const strategyContext = strategyState
    ? `## Company Strategy\n${strategyState.currentStrategy}\n\nBeliefs: ${strategyState.beliefs.join("; ")}\nHypotheses: ${strategyState.hypotheses.join("; ")}`
    : "No strategy defined yet. Use your best judgment.";

  const outputs: AgentOutput[] = [];

  for (const agent of AGENT_TEAM) {
    try {
      const output = await runAgent(db, companyId, agent, strategyContext, metrics);
      if (output) {
        outputs.push(output);

        await db.insert(activityLog).values({
          companyId,
          actorType: "system",
          actorId: `agent-${agent.name.toLowerCase()}`,
          agentId: null,
          runId: null,
          action: `agent.${agent.name.toLowerCase()}.analysis`,
          entityType: "company",
          entityId: companyId,
          details: {
            agent: agent.name,
            role: agent.role,
            analysis: output.analysis.slice(0, 200),
            decisionCount: output.decisions.length,
          },
        });
      }
    } catch (err) {
      logger.warn({ err, agent: agent.name }, "Agent analysis failed");
    }
  }

  if (outputs.length === 0) return;

  const actions = resolveConflicts(outputs);

  logger.info(
    {
      companyId,
      agents: outputs.map((o) => o.agent),
      totalDecisions: outputs.reduce((s, o) => s + o.decisions.length, 0),
      finalActions: actions.length,
    },
    "Multi-agent coordination completed — executing top actions",
  );

  const results = await executeActions(db, companyId, actions);

  await db.insert(activityLog).values({
    companyId,
    actorType: "system",
    actorId: "agent-coordinator",
    agentId: null,
    runId: null,
    action: "agent.coordinator.cycle.completed",
    entityType: "company",
    entityId: companyId,
    details: {
      agentCount: outputs.length,
      totalDecisions: outputs.reduce((s, o) => s + o.decisions.length, 0),
      finalActions: actions.length,
      executed: results.filter((r) => r.executed).length,
      succeeded: results.filter((r) => r.success).length,
      skipped: results.filter((r) => r.method === "skipped").length,
    },
  });

  // Skill extraction after each cycle — learn from what happened
  try {
    await extractSkillsFromRecentPerformance(db, companyId);
  } catch (err) {
    logger.debug({ err }, "Skill extraction after coordination failed");
  }

  // Daily skill decay
  try {
    await decayAllSkills(db, companyId, 0.995);
  } catch (err) {
    logger.debug({ err }, "Skill decay failed");
  }

  eventBus.publish("agent.coordinator.completed", {
    companyId,
    agents: outputs.map((o) => o.agent),
    actionsExecuted: results.filter((r) => r.executed).length,
    timestamp: new Date().toISOString(),
  });
}

let coordinatorInterval: ReturnType<typeof setInterval> | null = null;

export function startAgentCoordinator(db: Db, intervalMs = 6 * 60 * 60_000): () => void {
  const enabled = (process.env.AGENT_COORDINATOR_ENABLED ?? "true").trim().toLowerCase();
  if (enabled === "false" || enabled === "0") {
    logger.info("Agent coordinator disabled");
    return () => {};
  }

  logger.info({ intervalMs }, "Starting agent coordinator");

  setTimeout(async () => {
    try {
      const companyIds = await listScopedCompanyIds(db, { limit: 3 });
      for (const companyId of companyIds) {
        await runCoordinatedCycle(db, companyId);
      }
    } catch (err) {
      logger.error({ err }, "Agent coordinator initial cycle failed");
    }
  }, 6 * 60_000);

  coordinatorInterval = setInterval(async () => {
    try {
      const companyIds = await listScopedCompanyIds(db, { limit: 3 });
      for (const companyId of companyIds) {
        await runCoordinatedCycle(db, companyId);
      }
    } catch (err) {
      logger.error({ err }, "Agent coordinator cycle failed");
    }
  }, intervalMs);

  return () => {
    if (coordinatorInterval) {
      clearInterval(coordinatorInterval);
      coordinatorInterval = null;
    }
  };
}
