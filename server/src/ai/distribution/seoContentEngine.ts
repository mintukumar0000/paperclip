import type { Db } from "@paperclipai/db";
import { activityLog } from "@paperclipai/db";
import pino from "pino";
import { generateWithQualityGate } from "../quality/executionQualityGate.js";
import { eventBus } from "../../events/eventBus.js";

const logger = pino({ name: "seo-content-engine" });

interface BlogPost {
  title: string;
  slug: string;
  metaDescription: string;
  content: string;
  targetKeyword: string;
}

const SEO_KEYWORDS = [
  "cold email templates for startups",
  "best cold email subject lines",
  "cold outreach templates free",
  "how to write cold emails that convert",
  "founder cold email strategy",
  "SaaS cold email templates",
  "cold email follow up sequence",
  "B2B cold email templates",
  "cold email for indie hackers",
  "startup outbound email guide",
];

export async function generateBlogPost(keyword: string): Promise<BlogPost | null> {
  const content = await generateWithQualityGate("seo", [
    {
      role: "system",
      content: `You are an SEO content writer. Write a comprehensive blog post optimized for a target keyword.

Requirements:
- 800-1200 words
- Include the keyword naturally 4-6 times
- Use H2 and H3 subheadings
- Include actionable tips
- End with a soft CTA to a cold email template product
- Write in first person, conversational tone
- Format as HTML

Return ONLY the HTML content. No markdown fences.`,
    },
    {
      role: "user",
      content: `Write a blog post targeting the keyword: "${keyword}"

Product context: We sell a cold email template pack for $5-$9 aimed at startup founders.
CTA link: https://writenaturallyai.com?source=blog_${keyword.replace(/\s+/g, "_")}`,
    },
  ], "blog", 3);

  if (!content) return null;

  const titleMatch = content.match(/<h1[^>]*>(.*?)<\/h1>/i) ??
    content.match(/<title>(.*?)<\/title>/i);

  const title = titleMatch?.[1]?.replace(/<[^>]*>/g, "") ?? `Guide: ${keyword}`;
  const slug = keyword.replace(/\s+/g, "-").toLowerCase().replace(/[^a-z0-9-]/g, "");

  const metaMatch = content.match(/<meta\s+name="description"\s+content="([^"]*)"/) ?? null;
  const metaDescription = metaMatch?.[1] ?? `Learn about ${keyword}. Practical tips and templates for founders.`;

  return {
    title,
    slug,
    metaDescription,
    content,
    targetKeyword: keyword,
  };
}

export async function publishBlogPost(
  db: Db,
  companyId: string,
  post: BlogPost,
): Promise<{ published: boolean; method: string; url?: string }> {
  const vercelToken = (process.env.VERCEL_TOKEN ?? "").trim();
  const deployHook = (process.env.VERCEL_DEPLOY_HOOK_URL ?? "").trim();

  // Store blog content in activity log for now
  await db.insert(activityLog).values({
    companyId,
    actorType: "system",
    actorId: "seo-content-engine",
    agentId: null,
    runId: null,
    action: "content.blog.generated",
    entityType: "company",
    entityId: companyId,
    details: {
      title: post.title,
      slug: post.slug,
      keyword: post.targetKeyword,
      metaDescription: post.metaDescription,
      contentLength: post.content.length,
      content: post.content.slice(0, 2000),
    },
  });

  if (deployHook) {
    try {
      await fetch(deployHook, { method: "POST" });
      logger.info({ slug: post.slug }, "Triggered Vercel deploy for new blog post");
    } catch (err) {
      logger.warn({ err }, "Vercel deploy trigger failed");
    }
  }

  logger.info({ title: post.title, keyword: post.targetKeyword }, "Blog post generated and stored");
  return { published: true, method: "stored", url: `/blog/${post.slug}` };
}

let seoInterval: ReturnType<typeof setInterval> | null = null;
let keywordIndex = 0;

export function startSEOContentEngine(db: Db, intervalMs = 12 * 60 * 60_000): () => void {
  const enabled = (process.env.SEO_ENGINE_ENABLED ?? "true").trim().toLowerCase();
  if (enabled === "false" || enabled === "0") {
    logger.info("SEO content engine disabled");
    return () => {};
  }

  const companyId = (process.env.BILLING_WEBHOOK_COMPANY_ID ?? "").trim();
  if (!companyId) {
    logger.warn("SEO engine: no BILLING_WEBHOOK_COMPANY_ID set");
    return () => {};
  }

  logger.info({ intervalMs, keywords: SEO_KEYWORDS.length }, "Starting SEO content engine");

  setTimeout(async () => {
    try {
      const keyword = SEO_KEYWORDS[keywordIndex % SEO_KEYWORDS.length]!;
      keywordIndex++;
      const post = await generateBlogPost(keyword);
      if (post) await publishBlogPost(db, companyId, post);
    } catch (err) {
      logger.error({ err }, "SEO content generation failed");
    }
  }, 10 * 60_000);

  seoInterval = setInterval(async () => {
    try {
      const keyword = SEO_KEYWORDS[keywordIndex % SEO_KEYWORDS.length]!;
      keywordIndex++;
      const post = await generateBlogPost(keyword);
      if (post) await publishBlogPost(db, companyId, post);
    } catch (err) {
      logger.error({ err }, "SEO content generation failed");
    }
  }, intervalMs);

  return () => {
    if (seoInterval) {
      clearInterval(seoInterval);
      seoInterval = null;
    }
  };
}
