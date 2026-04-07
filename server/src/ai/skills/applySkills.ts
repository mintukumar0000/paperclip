import type { Db } from "@paperclipai/db";
import pino from "pino";
import { getSkillsByCategory, type Skill, type SkillCategory, recordSkillUsage } from "./skillStore.js";

const logger = pino({ name: "apply-skills" });

export function buildSkillPromptBlock(skills: Skill[]): string {
  if (skills.length === 0) return "";

  const positive = skills.filter((s) => !s.metadata?.isNegative);
  const negative = skills.filter((s) => s.metadata?.isNegative);

  let block = "\n## Learned Skills (Use These)\n";

  if (positive.length > 0) {
    block += "Proven patterns (higher confidence = more reliable):\n";
    for (const s of positive) {
      block += `- ${s.pattern} (confidence: ${s.confidence.toFixed(2)})\n`;
      if (s.conditions.length > 0) {
        block += `  When: ${s.conditions.join(", ")}\n`;
      }
    }
  }

  if (negative.length > 0) {
    block += "\nPatterns to AVOID:\n";
    for (const s of negative) {
      block += `- ${s.pattern} (confidence: ${s.confidence.toFixed(2)})\n`;
    }
  }

  return block;
}

export async function getSkillsForTask(
  db: Db,
  companyId: string,
  category: SkillCategory,
  minConfidence = 0.3,
): Promise<{ skills: Skill[]; promptBlock: string }> {
  const skills = await getSkillsByCategory(db, companyId, category, minConfidence, 8);
  const promptBlock = buildSkillPromptBlock(skills);
  return { skills, promptBlock };
}

export async function recordSkillUsageForTask(
  db: Db,
  skills: Skill[],
  success: boolean,
): Promise<void> {
  for (const skill of skills) {
    try {
      await recordSkillUsage(db, skill.id, success);
    } catch (err) {
      logger.debug({ err, skillId: skill.id }, "Skill usage recording failed");
    }
  }
}

export function injectSkillsIntoMessages(
  messages: Array<{ role: string; content: string }>,
  skillBlock: string,
): Array<{ role: string; content: string }> {
  if (!skillBlock) return messages;

  return messages.map((msg, i) => {
    if (i === 0 && msg.role === "system") {
      return { ...msg, content: msg.content + "\n" + skillBlock };
    }
    return msg;
  });
}
