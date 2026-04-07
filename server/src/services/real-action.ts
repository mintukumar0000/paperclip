import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import { agents, issues, and, eq } from "@paperclipai/db";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

export interface RealActionResult {
  performed: boolean;
  artifactPath: string | null;
  reason: string | null;
}

type OperationalIntent =
  | "traffic_distribution"
  | "landing_optimization"
  | "email_automation"
  | "seo_content"
  | "pricing_optimization"
  | "generic_execution";

function shouldRunContentAction(input: { title: string; description: string | null; role: string }): boolean {
  const text = `${input.title}\n${input.description ?? ""}`.toLowerCase();
  if (input.role === "cmo") return true;
  return /(content|marketing|launch|thread|post|tweet|linkedin|blog|campaign)/.test(text);
}

function resolveIntent(input: { title: string; description: string | null; role: string }): OperationalIntent {
  const text = `${input.title}\n${input.description ?? ""}`.toLowerCase();

  if (/(reddit|twitter|x\b|distribution|traffic|channel|campaign|post)/.test(text)) {
    return "traffic_distribution";
  }
  if (/(landing|headline|cta|conversion|signup|funnel)/.test(text)) {
    return "landing_optimization";
  }
  if (/(email|newsletter|sequence|drip)/.test(text)) {
    return "email_automation";
  }
  if (/(seo|keyword|blog|article|content engine)/.test(text)) {
    return "seo_content";
  }
  if (/(pricing|price|offer|checkout|rpv|aov|upsell|tier)/.test(text)) {
    return "pricing_optimization";
  }
  if (input.role === "cmo") return "traffic_distribution";

  return "generic_execution";
}

function sanitizeName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function getOutputDir(): string {
  const configured = process.env.PAPERCLIP_REAL_ACTION_DIR?.trim();
  if (configured) return path.resolve(configured);
  return path.resolve(resolvePaperclipInstanceRoot(), "data", "real-actions");
}

export async function performPlaywrightRealActionForIssue(
  db: Db,
  params: { companyId: string; issueId: string; agentId: string; runId?: string },
): Promise<RealActionResult> {
  const [issue, agent] = await Promise.all([
    db
      .select({ id: issues.id, title: issues.title, description: issues.description })
      .from(issues)
      .where(and(eq(issues.id, params.issueId), eq(issues.companyId, params.companyId)))
      .then((rows) => rows[0] ?? null),
    db
      .select({ id: agents.id, role: agents.role, name: agents.name })
      .from(agents)
      .where(and(eq(agents.id, params.agentId), eq(agents.companyId, params.companyId)))
      .then((rows) => rows[0] ?? null),
  ]);

  if (!issue || !agent) {
    return { performed: false, artifactPath: null, reason: "issue_or_agent_not_found" };
  }

  const intent = resolveIntent({ title: issue.title, description: issue.description, role: agent.role });

  if (!shouldRunContentAction({ title: issue.title, description: issue.description, role: agent.role }) && intent === "generic_execution") {
    return { performed: false, artifactPath: null, reason: "issue_not_actionable_for_runtime_tools" };
  }

  const outputDir = getOutputDir();
  await mkdir(outputDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const baseName = `${stamp}-${sanitizeName(issue.title) || issue.id}`;
  const metaPath = path.join(outputDir, `${baseName}.json`);

  try {
    let details: Record<string, unknown> = { intent };

    if (intent === "traffic_distribution") {
      const { _runTrafficCycleForTest } = await import("../core/trafficLoop.js");
      const baseUrl = (process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL ?? "http://localhost:3100").trim();
      await _runTrafficCycleForTest({ db, baseUrl });
      details = { ...details, action: "traffic_cycle_triggered", baseUrl };
    } else if (intent === "landing_optimization") {
      const { generateLandingVariants } = await import("../ai/distribution/landingVariants.js");
      const variants = await generateLandingVariants(db, params.companyId);
      details = { ...details, action: "landing_variants_generated", variantCount: variants.length };
    } else if (intent === "email_automation") {
      const { runEmailSequenceCycle } = await import("../ai/distribution/emailSequence.js");
      await runEmailSequenceCycle(db);
      details = { ...details, action: "email_sequence_cycle_triggered" };
    } else if (intent === "seo_content") {
      const { generateBlogPost, publishBlogPost } = await import("../ai/distribution/seoContentEngine.js");
      const keyword = "cold email templates for startups";
      const post = await generateBlogPost(keyword);
      if (!post) {
        details = { ...details, action: "seo_generation_failed", keyword };
      } else {
        const published = await publishBlogPost(db, params.companyId, post);
        details = { ...details, action: "seo_post_published", keyword, published };
      }
    } else if (intent === "pricing_optimization") {
      await db.insert(issues).values({
        companyId: params.companyId,
        title: `Pricing optimization follow-up: ${issue.title}`,
        description: `Auto-generated from runtime execution for issue ${issue.id}.\n\n${issue.description ?? ""}`,
        status: "backlog",
        priority: "high",
      });
      details = { ...details, action: "pricing_followup_issue_created" };
    } else {
      details = { ...details, action: "no_matching_runtime_action" };
    }

    await writeFile(
      metaPath,
      JSON.stringify(
        {
          kind: "runtime_action",
          companyId: params.companyId,
          issueId: issue.id,
          issueTitle: issue.title,
          agentId: agent.id,
          agentName: agent.name,
          runId: params.runId ?? null,
          details,
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );

    return {
      performed: true,
      artifactPath: metaPath,
      reason: `runtime_${intent}`,
    };
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err);
    await writeFile(
      metaPath,
      JSON.stringify(
        {
          kind: "runtime_action_failed",
          companyId: params.companyId,
          issueId: issue.id,
          issueTitle: issue.title,
          agentId: agent.id,
          agentName: agent.name,
          runId: params.runId ?? null,
          intent,
          error: errMessage,
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );

    return {
      performed: false,
      artifactPath: metaPath,
      reason: `runtime_action_failed:${intent}`,
    };
  }
}
