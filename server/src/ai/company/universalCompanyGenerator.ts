import type { Db } from "@paperclipai/db";
import { companies, agents, goals, projects, activityLog } from "@paperclipai/db";
import { randomUUID } from "node:crypto";
import pino from "pino";
import { routeLLMJSON } from "../llmRouter.js";
import { saveSkill } from "../skills/skillStore.js";

const logger = pino({ name: "company-generator" });

export interface CompanyBlueprint {
  name: string;
  description: string;
  businessModel: string;
  targetAudience: string;
  pricingStrategy: string;
  channels: string[];
  agents: Array<{
    name: string;
    role: string;
    systemPrompt: string;
  }>;
  goals: Array<{
    title: string;
    description: string;
    level: string;
  }>;
  landingHeadline: string;
  landingSubheadline: string;
  landingCta: string;
  emailSequence: Array<{
    step: string;
    subject: string;
    angle: string;
  }>;
  initialSkills: Array<{
    name: string;
    category: string;
    pattern: string;
  }>;
  weekOnePlan: string[];
}

export async function generateCompanyBlueprint(
  prompt: string,
): Promise<CompanyBlueprint | null> {
  const result = await routeLLMJSON<Record<string, unknown>>("strategy", [
    {
      role: "system",
      content: `You are a startup architect. Given a business idea, you generate a complete company blueprint that an autonomous AI system can execute.

You must be SPECIFIC. Not "sell digital products" but "sell Notion template packs for project managers at $9-$19 via Reddit and Product Hunt."

Return JSON:
{
  "name": "Company Name",
  "description": "One sentence describing the business",
  "business_model": "How it makes money (product type, pricing model)",
  "target_audience": "Specific ICP with demographics and pain points",
  "pricing_strategy": "Specific price points with reasoning",
  "channels": ["channel1", "channel2", "channel3"],
  "agents": [
    {
      "name": "Agent Name",
      "role": "ceo|cmo|cro|cfo|engineer|content",
      "system_prompt": "Full system prompt for this agent (3-5 sentences)"
    }
  ],
  "goals": [
    {
      "title": "Goal title",
      "description": "Specific measurable goal",
      "level": "company|team|individual"
    }
  ],
  "landing_headline": "High-converting headline",
  "landing_subheadline": "Supporting copy with specific proof point",
  "landing_cta": "CTA button text",
  "email_sequence": [
    { "step": "value", "subject": "Subject line", "angle": "What psychological angle" },
    { "step": "case_study", "subject": "Subject line", "angle": "What angle" },
    { "step": "urgency", "subject": "Subject line", "angle": "What angle" }
  ],
  "initial_skills": [
    {
      "name": "skill_name",
      "category": "traffic|conversion|pricing|email|strategy",
      "pattern": "Reusable pattern for this business type"
    }
  ],
  "week_one_plan": ["Specific action 1", "Specific action 2", "Specific action 3"]
}

Include at least:
- 4 agents (CEO, CMO, CRO, CFO minimum)
- 3 goals (revenue, traffic, conversion)
- 3 channels
- 5 initial skills (transferred from general knowledge)
- 3 week-one actions`,
    },
    {
      role: "user",
      content: `Create a complete company blueprint for: "${prompt}"

The company must be launchable by an autonomous AI system with zero human intervention. Include everything needed to start generating revenue within 7 days.`,
    },
  ]);

  if (!result) return null;

  const agentsRaw = result.agents as Array<Record<string, string>> | undefined;
  const goalsRaw = result.goals as Array<Record<string, string>> | undefined;
  const emailRaw = result.email_sequence as Array<Record<string, string>> | undefined;
  const skillsRaw = result.initial_skills as Array<Record<string, string>> | undefined;

  return {
    name: String(result.name ?? "Unnamed Company"),
    description: String(result.description ?? ""),
    businessModel: String(result.business_model ?? ""),
    targetAudience: String(result.target_audience ?? ""),
    pricingStrategy: String(result.pricing_strategy ?? ""),
    channels: Array.isArray(result.channels) ? result.channels.map(String) : [],
    agents: Array.isArray(agentsRaw)
      ? agentsRaw.map((a) => ({
          name: String(a.name ?? ""),
          role: String(a.role ?? ""),
          systemPrompt: String(a.system_prompt ?? ""),
        }))
      : [],
    goals: Array.isArray(goalsRaw)
      ? goalsRaw.map((g) => ({
          title: String(g.title ?? ""),
          description: String(g.description ?? ""),
          level: String(g.level ?? "company"),
        }))
      : [],
    landingHeadline: String(result.landing_headline ?? ""),
    landingSubheadline: String(result.landing_subheadline ?? ""),
    landingCta: String(result.landing_cta ?? ""),
    emailSequence: Array.isArray(emailRaw)
      ? emailRaw.map((e) => ({
          step: String(e.step ?? ""),
          subject: String(e.subject ?? ""),
          angle: String(e.angle ?? ""),
        }))
      : [],
    initialSkills: Array.isArray(skillsRaw)
      ? skillsRaw.map((s) => ({
          name: String(s.name ?? ""),
          category: String(s.category ?? "strategy"),
          pattern: String(s.pattern ?? ""),
        }))
      : [],
    weekOnePlan: Array.isArray(result.week_one_plan) ? result.week_one_plan.map(String) : [],
  };
}

export async function deployCompanyFromBlueprint(
  db: Db,
  blueprint: CompanyBlueprint,
): Promise<{ companyId: string; agentCount: number; goalCount: number; skillCount: number }> {
  const companyId = randomUUID();
  const prefix = blueprint.name
    .replace(/[^a-zA-Z0-9 ]/g, "")
    .split(/\s+/)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("")
    .slice(0, 4) || "CO";
  const suffix = randomUUID().slice(0, 4).toUpperCase();

  await db.insert(companies).values({
    id: companyId,
    name: blueprint.name,
    issuePrefix: `${prefix}-${suffix}`,
  });

  for (const agentDef of blueprint.agents) {
    await db.insert(agents).values({
      companyId,
      name: agentDef.name,
      role: agentDef.role,
      status: "idle",
      runtimeConfig: {
        systemPrompt: agentDef.systemPrompt,
      },
    });
  }

  for (const goalDef of blueprint.goals) {
    await db.insert(goals).values({
      id: randomUUID(),
      companyId,
      title: goalDef.title,
      description: goalDef.description,
      status: "active",
      level: goalDef.level as "company" | "team" | "individual",
    });
  }

  let skillCount = 0;
  for (const skillDef of blueprint.initialSkills) {
    try {
      await saveSkill(db, companyId, {
        name: skillDef.name,
        category: skillDef.category as any,
        pattern: skillDef.pattern,
        source: "behavior",
        metadata: { source: "company_generator", businessType: blueprint.businessModel },
      });
      skillCount++;
    } catch { /* skill save failed */ }
  }

  await db.insert(activityLog).values({
    companyId,
    actorType: "system",
    actorId: "company-generator",
    agentId: null,
    runId: null,
    action: "company.generated.from_prompt",
    entityType: "company",
    entityId: companyId,
    details: {
      name: blueprint.name,
      businessModel: blueprint.businessModel,
      targetAudience: blueprint.targetAudience,
      agentCount: blueprint.agents.length,
      goalCount: blueprint.goals.length,
      skillCount,
      channels: blueprint.channels,
      weekOnePlan: blueprint.weekOnePlan,
      landingHeadline: blueprint.landingHeadline,
    },
  });

  logger.info(
    { companyId, name: blueprint.name, agents: blueprint.agents.length, skills: skillCount },
    "Company deployed from blueprint",
  );

  return { companyId, agentCount: blueprint.agents.length, goalCount: blueprint.goals.length, skillCount };
}

export async function generateAndDeployCompany(
  db: Db,
  prompt: string,
): Promise<{
  companyId: string;
  blueprint: CompanyBlueprint;
  deployment: { agentCount: number; goalCount: number; skillCount: number };
} | null> {
  const blueprint = await generateCompanyBlueprint(prompt);
  if (!blueprint) {
    logger.warn({ prompt: prompt.slice(0, 100) }, "Failed to generate company blueprint");
    return null;
  }

  const deployment = await deployCompanyFromBlueprint(db, blueprint);
  return { companyId: deployment.companyId, blueprint, deployment };
}
