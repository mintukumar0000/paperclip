import type { Db } from "@paperclipai/db";
import { aiSkills, eq, and, desc, sql, gte, lt } from "@paperclipai/db";
import pino from "pino";

const logger = pino({ name: "skill-store" });

export type SkillCategory = "traffic" | "conversion" | "pricing" | "email" | "strategy" | "ops";
export type SkillSource = "content" | "pricing" | "email" | "landing" | "behavior";

export interface Skill {
  id: string;
  companyId: string;
  name: string;
  category: SkillCategory;
  pattern: string;
  conditions: string[];
  expectedOutcome: string | null;
  confidence: number;
  usageCount: number;
  successCount: number;
  failureCount: number;
  source: string | null;
  embedding: number[] | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

function rowToSkill(row: typeof aiSkills.$inferSelect): Skill {
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    category: row.category as SkillCategory,
    pattern: row.pattern,
    conditions: row.conditions ?? [],
    expectedOutcome: row.expectedOutcome,
    confidence: row.confidence,
    usageCount: row.usageCount,
    successCount: row.successCount,
    failureCount: row.failureCount,
    source: row.source,
    embedding: row.embedding,
    metadata: row.metadata ?? {},
    createdAt: row.createdAt?.toISOString() ?? "",
    updatedAt: row.updatedAt?.toISOString() ?? "",
  };
}

export async function saveSkill(
  db: Db,
  companyId: string,
  skill: {
    name: string;
    category: SkillCategory;
    pattern: string;
    conditions?: string[];
    expectedOutcome?: string;
    source?: SkillSource;
    metadata?: Record<string, unknown>;
    embedding?: number[] | null;
  },
): Promise<Skill> {
  const existing = await db
    .select()
    .from(aiSkills)
    .where(and(eq(aiSkills.companyId, companyId), eq(aiSkills.name, skill.name)))
    .limit(1);

  if (existing.length > 0) {
    const row = existing[0]!;
    const newConfidence = Math.min(1, row.confidence + 0.1);
    await db
      .update(aiSkills)
      .set({
        pattern: skill.pattern,
        confidence: newConfidence,
        conditions: skill.conditions ?? row.conditions,
        expectedOutcome: skill.expectedOutcome ?? row.expectedOutcome,
        metadata: { ...(row.metadata ?? {}), ...(skill.metadata ?? {}) },
        embedding: skill.embedding ?? row.embedding,
        updatedAt: new Date(),
      })
      .where(eq(aiSkills.id, row.id));

    logger.debug({ skillId: row.id, name: skill.name, confidence: newConfidence }, "Skill reinforced");
    return rowToSkill({ ...row, confidence: newConfidence, pattern: skill.pattern });
  }

  const [inserted] = await db
    .insert(aiSkills)
    .values({
      companyId,
      name: skill.name,
      category: skill.category,
      pattern: skill.pattern,
      conditions: skill.conditions ?? [],
      expectedOutcome: skill.expectedOutcome ?? null,
      confidence: 0.6,
      source: skill.source ?? null,
      metadata: skill.metadata ?? {},
      embedding: skill.embedding ?? null,
    })
    .returning();

  logger.info({ name: skill.name, category: skill.category }, "New skill created");
  return rowToSkill(inserted!);
}

export async function getSkillsByCategory(
  db: Db,
  companyId: string,
  category: SkillCategory,
  minConfidence = 0.3,
  limit = 10,
): Promise<Skill[]> {
  const rows = await db
    .select()
    .from(aiSkills)
    .where(
      and(
        eq(aiSkills.companyId, companyId),
        eq(aiSkills.category, category),
        gte(aiSkills.confidence, minConfidence),
      ),
    )
    .orderBy(desc(aiSkills.confidence))
    .limit(limit);

  return rows.map(rowToSkill);
}

export async function getTopSkills(
  db: Db,
  companyId: string,
  limit = 15,
): Promise<Skill[]> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60_000);
  const rows = await db
    .select()
    .from(aiSkills)
    .where(and(eq(aiSkills.companyId, companyId), gte(aiSkills.confidence, 0.3)))
    .orderBy(sql`${aiSkills.confidence} * (${aiSkills.usageCount} + 1) * CASE WHEN ${aiSkills.updatedAt} >= ${sevenDaysAgo} THEN 1.5 ELSE 1.0 END DESC`)
    .limit(limit);

  return rows.map(rowToSkill);
}

export async function recordSkillUsage(
  db: Db,
  skillId: string,
  success: boolean,
): Promise<void> {
  await db
    .update(aiSkills)
    .set({
      usageCount: sql`${aiSkills.usageCount} + 1`,
      successCount: success ? sql`${aiSkills.successCount} + 1` : aiSkills.successCount,
      failureCount: success ? aiSkills.failureCount : sql`${aiSkills.failureCount} + 1`,
      confidence: success
        ? sql`LEAST(${aiSkills.confidence} + 0.1, 1.0)`
        : sql`GREATEST(${aiSkills.confidence} - 0.1, 0.0)`,
      updatedAt: new Date(),
    })
    .where(eq(aiSkills.id, skillId));
}

export async function decayAllSkills(db: Db, companyId: string, factor = 0.98): Promise<number> {
  const result = await db
    .update(aiSkills)
    .set({
      confidence: sql`${aiSkills.confidence} * ${factor}`,
      updatedAt: new Date(),
    })
    .where(and(eq(aiSkills.companyId, companyId), gte(aiSkills.confidence, 0.05)));

  await db
    .delete(aiSkills)
    .where(and(eq(aiSkills.companyId, companyId), lt(aiSkills.confidence, 0.05)));

  return 0;
}

export async function getAllSkills(db: Db, companyId: string): Promise<Skill[]> {
  const rows = await db
    .select()
    .from(aiSkills)
    .where(eq(aiSkills.companyId, companyId))
    .orderBy(desc(aiSkills.confidence));

  return rows.map(rowToSkill);
}
