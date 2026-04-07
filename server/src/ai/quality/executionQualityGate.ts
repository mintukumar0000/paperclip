import pino from "pino";
import { routeLLM, type LLMTask } from "../llmRouter.js";

const logger = pino({ name: "quality-gate" });

export type ContentType = "reddit_post" | "reddit_reply" | "tweet" | "email" | "landing_headline" | "blog";

interface QualityResult {
  valid: boolean;
  reasons: string[];
  score: number;
}

const RULES: Record<ContentType, Array<{ test: (text: string) => boolean; reason: string; weight: number }>> = {
  reddit_post: [
    { test: (t) => /\d/.test(t), reason: "Must include at least one number/metric", weight: 2 },
    { test: (t) => /(I|we|my)\s/i.test(t), reason: "Must include first-person voice", weight: 2 },
    { test: (t) => t.length >= 80, reason: "Must be at least 80 characters", weight: 1 },
    { test: (t) => t.length <= 2000, reason: "Must be under 2000 characters", weight: 1 },
    { test: (t) => !/great question|i'd be happy|here's what/i.test(t), reason: "Must not sound like ChatGPT", weight: 3 },
    { test: (t) => !/^(here are|in this post|let me share)/i.test(t), reason: "Must not start with generic AI opener", weight: 2 },
  ],
  reddit_reply: [
    { test: (t) => t.length >= 30, reason: "Must be at least 30 characters", weight: 1 },
    { test: (t) => t.length <= 500, reason: "Must be under 500 characters", weight: 1 },
    { test: (t) => !/great question|i'd be happy|here's what I suggest/i.test(t), reason: "Must not sound like ChatGPT", weight: 3 },
    { test: (t) => !t.includes("•") && !t.includes("- "), reason: "No bullet points in Reddit replies", weight: 2 },
    { test: (t) => !/^(Sure|Absolutely|Certainly|Of course)/i.test(t), reason: "Must not start with AI filler words", weight: 2 },
  ],
  tweet: [
    { test: (t) => t.length >= 30, reason: "Must be at least 30 characters", weight: 1 },
    { test: (t) => t.length <= 280, reason: "Must fit in a tweet", weight: 1 },
    { test: (t) => /\d/.test(t), reason: "Should include a number", weight: 1 },
  ],
  email: [
    { test: (t) => t.length >= 100, reason: "Must be at least 100 characters", weight: 1 },
    { test: (t) => /\d/.test(t), reason: "Must include at least one number", weight: 2 },
    { test: (t) => /<a|href=/i.test(t), reason: "Must include a CTA link", weight: 2 },
  ],
  landing_headline: [
    { test: (t) => t.length >= 15, reason: "Must be at least 15 characters", weight: 1 },
    { test: (t) => t.length <= 120, reason: "Must be under 120 characters", weight: 1 },
    { test: (t) => /\d/.test(t) || /(you|your|founder)/i.test(t), reason: "Must include number or address reader directly", weight: 2 },
  ],
  blog: [
    { test: (t) => t.length >= 500, reason: "Must be at least 500 characters", weight: 1 },
    { test: (t) => /<h[23]/i.test(t), reason: "Must include subheadings", weight: 1 },
    { test: (t) => /\d/.test(t), reason: "Must include numbers", weight: 1 },
  ],
};

export function validateOutput(text: string, contentType: ContentType): QualityResult {
  const rules = RULES[contentType] ?? [];
  const reasons: string[] = [];
  let totalWeight = 0;
  let passedWeight = 0;

  for (const rule of rules) {
    totalWeight += rule.weight;
    if (rule.test(text)) {
      passedWeight += rule.weight;
    } else {
      reasons.push(rule.reason);
    }
  }

  const score = totalWeight > 0 ? passedWeight / totalWeight : 1;
  const valid = score >= 0.6;

  return { valid, reasons, score };
}

export async function generateWithQualityGate(
  task: LLMTask,
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  contentType: ContentType,
  maxAttempts = 3,
): Promise<string | null> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await routeLLM(task, messages);
    if (!response?.content) continue;

    const { valid, reasons, score } = validateOutput(response.content, contentType);

    if (valid) {
      if (attempt > 0) {
        logger.debug({ contentType, attempt, score }, "Content passed quality gate on retry");
      }
      return response.content;
    }

    logger.debug(
      { contentType, attempt, score, reasons },
      "Content rejected by quality gate — regenerating",
    );

    const feedbackMsg = `Your previous output was rejected for these reasons:\n${reasons.map((r) => `- ${r}`).join("\n")}\n\nFix these issues and try again. Be more specific, include real numbers, and sound like a human founder.`;
    messages.push({ role: "assistant", content: response.content });
    messages.push({ role: "user", content: feedbackMsg });
  }

  logger.warn({ contentType, maxAttempts }, "Quality gate: all attempts failed");
  return null;
}
