import type { Db } from "@paperclipai/db";
import { aiLearningRecords, waitlistSignups, activityLog } from "@paperclipai/db";
import { and, eq, desc, sql } from "@paperclipai/db";
import pino from "pino";
import type { SystemMetricSnapshot } from "../feedback/metricsEngine.js";
import type { DecisionAction } from "./decisionEngine.js";
import { buildMemoryContext, recordActionOutcome } from "../../memory/embeddingMemory.js";
import { getSkillsForTask } from "../skills/applySkills.js";
import { getStrategyState } from "../brain/strategyBrain.js";

const logger = pino({ name: "llm-decision-advisor" });

function usesCompletionTokens(model: string): boolean {
  return /^gpt-5(?:$|[.-])/.test(model);
}

interface EmailPerformanceRecord {
  email: string;
  tier: string;
  converted: boolean;
  amountCents: number;
  subjectPattern: string;
}

interface LLMDecisionAdvice {
  reasoning: string;
  suggestedActions: DecisionAction[];
  pricingAdvice: string | null;
  audienceAdvice: string | null;
  channelAdvice: string | null;
}

// STEP 4: Light Learning Loop — query top/bottom email performance
async function getEmailPerformanceData(db: Db, companyId: string): Promise<{
  topPerformers: EmailPerformanceRecord[];
  bottomPerformers: EmailPerformanceRecord[];
  totalSent: number;
  totalConverted: number;
}> {
  const converted = await db
    .select()
    .from(aiLearningRecords)
    .where(
      and(
        eq(aiLearningRecords.companyId, companyId),
        eq(aiLearningRecords.recordType, "evaluation"),
        eq(aiLearningRecords.category, "outcome"),
        sql`${aiLearningRecords.details} ->> 'eventType' = 'payment_completed'`,
      ),
    )
    .orderBy(desc(aiLearningRecords.createdAt))
    .limit(25);

  const topPerformers: EmailPerformanceRecord[] = converted
    .map((r) => {
      const details = (r.details ?? {}) as Record<string, unknown>;
      const metadata = (details.metadata ?? {}) as Record<string, unknown>;
      return {
        email: String(metadata.email ?? "unknown"),
        tier: String(metadata.tier ?? "entry"),
        converted: true,
        amountCents: Number(details.amountCents ?? 0),
        subjectPattern: String(metadata.subjectPattern ?? "unknown"),
      };
    })
    .sort((a, b) => b.amountCents - a.amountCents)
    .slice(0, 5);

  const [sentRow] = await db
    .select({ count: sql<number>`count(*) filter (where monetization_sent = true)::int` })
    .from(waitlistSignups)
    .where(eq(waitlistSignups.companyId, companyId));

  const totalSent = Number(sentRow?.count ?? 0);
  const totalConverted = converted.length;

  const bottomPerformers: EmailPerformanceRecord[] = [];
  if (totalSent > totalConverted) {
    const recentNonConverted = await db
      .select()
      .from(waitlistSignups)
      .where(
        and(
          eq(waitlistSignups.companyId, companyId),
          eq(waitlistSignups.monetizationSent, true),
        ),
      )
      .orderBy(desc(waitlistSignups.createdAt))
      .limit(20);

    const convertedEmails = new Set(topPerformers.map((p) => p.email.toLowerCase()));
    for (const signup of recentNonConverted) {
      if (!convertedEmails.has(signup.email.toLowerCase())) {
        bottomPerformers.push({
          email: signup.email,
          tier: "entry",
          converted: false,
          amountCents: 0,
          subjectPattern: "unknown",
        });
        if (bottomPerformers.length >= 5) break;
      }
    }
  }

  return { topPerformers, bottomPerformers, totalSent, totalConverted };
}

async function getRecentDecisionHistory(db: Db, companyId: string): Promise<string[]> {
  const rows = await db
    .select({ details: activityLog.details })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "ai.decision.action.executed"),
      ),
    )
    .orderBy(desc(activityLog.createdAt))
    .limit(15);

  return rows.map((r) => {
    const d = (r.details ?? {}) as Record<string, unknown>;
    return `[${d.actionType}] ${d.key}: ${d.reason ?? ""} (success=${d.success}, skipped=${(d as Record<string, unknown>).skipped ?? false})`;
  });
}

// STEP 3: LLM-powered decision analysis
export async function analyzeMeisticsWithLLM(
  db: Db,
  companyId: string,
  metrics: SystemMetricSnapshot,
  ruleBasedActions: DecisionAction[],
): Promise<LLMDecisionAdvice | null> {
  const apiKey = (process.env.OPENAI_API_KEY ?? "").trim();
  if (!apiKey) {
    logger.info("LLM decision advisor skipped: no OPENAI_API_KEY");
    return null;
  }

  const baseUrl = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").trim();
  const model = (process.env.OPENAI_MODEL ?? "gpt-4o-mini").trim();

  const emailData = await getEmailPerformanceData(db, companyId);
  const recentDecisions = await getRecentDecisionHistory(db, companyId);

  let memoryContext = "";
  try {
    memoryContext = await buildMemoryContext(db, companyId, "decision outcomes content performance pricing results", 8);
  } catch { /* memory system unavailable */ }

  let skillBlock = "";
  try {
    const { promptBlock } = await getSkillsForTask(db, companyId, "strategy");
    skillBlock = promptBlock;
  } catch { /* skills unavailable */ }

  let strategyContext = "";
  try {
    const state = await getStrategyState(db, companyId);
    if (state) {
      strategyContext = `\n## Strategy Brain State\nStrategy: ${state.currentStrategy}\nBeliefs: ${state.beliefs.join("; ")}\nHypotheses: ${state.hypotheses.join("; ")}\nExperiments: ${state.experiments.join("; ")}`;
    }
  } catch { /* strategy brain unavailable */ }

  const prompt = buildDecisionPrompt(metrics, ruleBasedActions, emailData, recentDecisions, memoryContext + strategyContext + skillBlock);

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    };
    const siteUrl = (process.env.OPENROUTER_SITE_URL ?? "").trim();
    const appName = (process.env.OPENROUTER_APP_NAME ?? "").trim();
    if (siteUrl) headers["HTTP-Referer"] = siteUrl;
    if (appName) headers["X-Title"] = appName;

    const requestBody: Record<string, unknown> = {
      model,
      temperature: 0.4,
      messages: [
        {
          role: "system",
          content: `You are a startup growth advisor AI. Analyze business metrics and recommend concrete actions.
You must respond in valid JSON with this exact structure:
{
  "reasoning": "2-3 sentence analysis of WHY metrics look this way",
  "pricing_advice": "specific pricing recommendation or null",
  "audience_advice": "specific audience/channel recommendation or null",
  "channel_advice": "specific distribution channel recommendation or null",
  "new_actions": [
    {
      "key": "action_key",
      "title": "Issue title",
      "description": "What to do",
      "priority": "high|medium|low",
      "reason": "Why this matters"
    }
  ]
}
Only suggest actions that are NOT already in the rule-based actions list. Focus on WHY and WHAT TO CHANGE, not just detecting problems.`,
        },
        { role: "user", content: prompt },
      ],
    };
    if (usesCompletionTokens(model)) {
      requestBody.max_completion_tokens = 800;
    } else {
      requestBody.max_tokens = 800;
    }

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      logger.warn({ status: response.status, body: text.slice(0, 200) }, "LLM decision advisor request failed");
      return null;
    }

    const data = (await response.json()) as Record<string, unknown>;
    const choices = data.choices as Array<{ message?: { content?: string } }> | undefined;
    let content = choices?.[0]?.message?.content?.trim();
    if (!content) return null;

    // Strip markdown code fences that LLMs sometimes wrap JSON in
    if (content.startsWith("```")) {
      content = content.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
    }

    const parsed = JSON.parse(content) as Record<string, unknown>;

    const suggestedActions: DecisionAction[] = [];
    const newActions = parsed.new_actions;
    if (Array.isArray(newActions)) {
      for (const a of newActions) {
        const action = a as Record<string, unknown>;
        if (typeof action.key === "string" && typeof action.title === "string") {
          suggestedActions.push({
            type: "create_issue",
            key: `llm_${action.key}`,
            reason: String(action.reason ?? "LLM-suggested improvement"),
            payload: {
              title: String(action.title),
              description: String(action.description ?? ""),
              priority: String(action.priority ?? "medium"),
            },
          });
        }
      }
    }

    const advice: LLMDecisionAdvice = {
      reasoning: String(parsed.reasoning ?? "No analysis provided"),
      suggestedActions,
      pricingAdvice: parsed.pricing_advice ? String(parsed.pricing_advice) : null,
      audienceAdvice: parsed.audience_advice ? String(parsed.audience_advice) : null,
      channelAdvice: parsed.channel_advice ? String(parsed.channel_advice) : null,
    };

    logger.info(
      {
        companyId,
        reasoning: advice.reasoning.slice(0, 100),
        suggestedActionCount: suggestedActions.length,
        hasPricingAdvice: !!advice.pricingAdvice,
        hasAudienceAdvice: !!advice.audienceAdvice,
      },
      "LLM decision advisor completed",
    );

    return advice;
  } catch (err) {
    logger.warn({ err }, "LLM decision advisor failed");
    return null;
  }
}

function buildDecisionPrompt(
  metrics: SystemMetricSnapshot,
  ruleBasedActions: DecisionAction[],
  emailData: Awaited<ReturnType<typeof getEmailPerformanceData>>,
  recentDecisions: string[],
  memoryContext?: string,
): string {
  const sections: string[] = [];

  sections.push(`## Current Business Metrics (last 3 hours)
- Traffic: ${metrics.traffic} visits
- Conversions: ${metrics.conversions}
- Payment Conversions: ${metrics.payment_conversions}
- Revenue: ${metrics.revenue} cents ($${(metrics.revenue / 100).toFixed(2)})
- Conversion Rate: ${metrics.conversion_rate.toFixed(2)}%
- Payment Conversion Rate: ${metrics.payment_conversion_rate.toFixed(2)}%
- Revenue per Visitor: ${metrics.revenue_per_visit.toFixed(2)} cents
- Revenue per User: ${metrics.revenue_per_user.toFixed(2)} cents
- Task Success Rate: ${(metrics.task_success_rate * 100).toFixed(1)}%
- Bounce Rate: ${metrics.bounce_rate.toFixed(1)}%`);

  sections.push(`## Rule-Based Actions Already Generated
${ruleBasedActions.map((a) => `- [${a.type}] ${a.key}: ${a.reason}`).join("\n") || "None"}`);

  if (emailData.totalSent > 0) {
    sections.push(`## Email Performance (Learning Data)
- Total offer emails sent: ${emailData.totalSent}
- Total conversions: ${emailData.totalConverted}
- Email-to-payment rate: ${emailData.totalSent > 0 ? ((emailData.totalConverted / emailData.totalSent) * 100).toFixed(1) : "0"}%

### Top 5 Converting Emails:
${emailData.topPerformers.map((p) => `- ${p.email} | tier=${p.tier} | amount=${p.amountCents}c | pattern=${p.subjectPattern}`).join("\n") || "None yet"}

### Bottom 5 Non-Converting Emails:
${emailData.bottomPerformers.map((p) => `- ${p.email} | sent offer but no payment`).join("\n") || "None tracked"}`);
  }

  if (recentDecisions.length > 0) {
    sections.push(`## Recent Decision History (last 15 actions)
${recentDecisions.join("\n")}`);
  }

  if (memoryContext && memoryContext !== "No relevant past memories found.") {
    sections.push(memoryContext);
  }

  sections.push(`## Your Task
Analyze these metrics, email performance data, and past memories. Answer:
1. WHY is conversion low? (not just "it's low" — find the root cause)
2. Which audience segment is converting? Which isn't?
3. What specific change would have the highest impact?
4. Should pricing change? If so, how?
5. Which distribution channel should be prioritized?
6. What past actions worked or failed? (use memory data if available)

Only suggest NEW actions not already in the rule-based list above.`);

  return sections.join("\n\n");
}

export { getEmailPerformanceData };
