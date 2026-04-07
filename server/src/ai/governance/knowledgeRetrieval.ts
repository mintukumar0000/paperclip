// ---------------------------------------------------------------------------
// Institutional Knowledge Retrieval
// ---------------------------------------------------------------------------
// Provides agents with access to organizational knowledge before planning.
// Agents should query relevant knowledge (policies, procedures, lessons learned,
// best practices) to inform their decisions rather than operating in a vacuum.
// ---------------------------------------------------------------------------

import type { Db } from "@paperclipai/db";
import { eq, and, sql } from "@paperclipai/db";
import { institutionalKnowledge } from "@paperclipai/db";
import pino from "pino";
import { eventBus } from "../../events/eventBus.js";

const logger = pino({ name: "knowledge-retrieval" });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Categories of knowledge that can be queried */
export type KnowledgeCategory =
  | "policy"
  | "procedure"
  | "lesson_learned"
  | "decision_record"
  | "best_practice";

/** A knowledge query request */
export interface KnowledgeQuery {
  companyId: string;
  /** The agent or actor requesting knowledge */
  requesterId: string;
  /** Natural-language description of the task/context for relevance */
  taskContext: string;
  /** Optional: filter to specific categories */
  categories?: KnowledgeCategory[];
  /** Optional: filter by tags */
  tags?: string[];
  /** Max number of results to return */
  limit?: number;
}

/** A single knowledge entry returned from retrieval */
export interface KnowledgeEntry {
  id: string;
  title: string;
  category: string;
  content: string;
  source: string | null;
  tags: string[];
  relevanceScore: number;
}

/** Result of a knowledge retrieval */
export interface KnowledgeRetrievalResult {
  entries: KnowledgeEntry[];
  totalMatches: number;
  queryTime: number;
}

// ---------------------------------------------------------------------------
// Relevance Scoring
// ---------------------------------------------------------------------------

/**
 * Simple keyword-based relevance scoring.
 * Scores each knowledge entry against the task context using term frequency.
 */
function scoreRelevance(
  content: string,
  title: string,
  tags: string[],
  taskContext: string,
): number {
  const contextWords = taskContext
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 2);

  if (contextWords.length === 0) return 0;

  const searchable = `${title} ${content} ${tags.join(" ")}`.toLowerCase();
  let matches = 0;

  for (const word of contextWords) {
    if (searchable.includes(word)) matches++;
  }

  // Normalize to 0-1 range
  return matches / contextWords.length;
}

// ---------------------------------------------------------------------------
// Core Retrieval
// ---------------------------------------------------------------------------

/**
 * Query institutional knowledge relevant to a task or decision context.
 * Returns approved knowledge entries scored by relevance.
 *
 * Agents should call this before planning to incorporate organizational
 * policies, past lessons, and best practices into their decisions.
 */
export async function queryKnowledge(
  db: Db,
  query: KnowledgeQuery,
): Promise<KnowledgeRetrievalResult> {
  const start = Date.now();
  const limit = query.limit ?? 10;

  // Fetch approved knowledge for this company
  const rows = await db
    .select()
    .from(institutionalKnowledge)
    .where(
      and(
        eq(institutionalKnowledge.companyId, query.companyId),
        eq(institutionalKnowledge.status, "approved"),
      ),
    );

  // Filter by categories if specified
  let filtered = rows;
  if (query.categories && query.categories.length > 0) {
    filtered = filtered.filter((r) =>
      query.categories!.includes(r.category as KnowledgeCategory),
    );
  }

  // Filter by tags if specified
  if (query.tags && query.tags.length > 0) {
    const queryTags = new Set(query.tags.map((t) => t.toLowerCase()));
    filtered = filtered.filter((r) => {
      const rowTags = (r.tags as string[] | null) ?? [];
      return rowTags.some((t) => queryTags.has(t.toLowerCase()));
    });
  }

  // Score by relevance to task context
  const scored: KnowledgeEntry[] = filtered.map((r) => ({
    id: r.id,
    title: r.title,
    category: r.category,
    content: r.content,
    source: r.source,
    tags: (r.tags as string[] | null) ?? [],
    relevanceScore: scoreRelevance(
      r.content,
      r.title,
      (r.tags as string[] | null) ?? [],
      query.taskContext,
    ),
  }));

  // Sort by relevance (highest first) and take top N
  scored.sort((a, b) => b.relevanceScore - a.relevanceScore);
  const topEntries = scored.filter((e) => e.relevanceScore > 0).slice(0, limit);

  const queryTime = Date.now() - start;

  // Emit telemetry
  eventBus.publish("governance.knowledge.queried", {
    companyId: query.companyId,
    requesterId: query.requesterId,
    categories: query.categories ?? [],
    tags: query.tags ?? [],
    totalKnowledge: rows.length,
    matchedEntries: topEntries.length,
    queryTimeMs: queryTime,
    timestamp: new Date().toISOString(),
  });

  logger.info(
    {
      companyId: query.companyId,
      requesterId: query.requesterId,
      matched: topEntries.length,
      total: rows.length,
      queryTimeMs: queryTime,
    },
    "Knowledge retrieval completed",
  );

  return {
    entries: topEntries,
    totalMatches: topEntries.length,
    queryTime,
  };
}

/**
 * Get knowledge entries relevant to a specific category.
 * Convenience wrapper for category-scoped queries (e.g., all policies).
 */
export async function getKnowledgeByCategory(
  db: Db,
  companyId: string,
  category: KnowledgeCategory,
): Promise<KnowledgeEntry[]> {
  const rows = await db
    .select()
    .from(institutionalKnowledge)
    .where(
      and(
        eq(institutionalKnowledge.companyId, companyId),
        eq(institutionalKnowledge.status, "approved"),
        eq(institutionalKnowledge.category, category),
      ),
    );

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    category: r.category,
    content: r.content,
    source: r.source,
    tags: (r.tags as string[] | null) ?? [],
    relevanceScore: 1, // all are exact category matches
  }));
}

/**
 * Build a knowledge context string for injection into agent prompts.
 * Returns a formatted text block with relevant knowledge for the task.
 */
export async function buildKnowledgeContext(
  db: Db,
  companyId: string,
  requesterId: string,
  taskContext: string,
): Promise<string> {
  const result = await queryKnowledge(db, {
    companyId,
    requesterId,
    taskContext,
    limit: 5,
  });

  if (result.entries.length === 0) {
    return "";
  }

  const sections = result.entries.map((entry, i) => {
    const tagStr = entry.tags.length > 0 ? ` [${entry.tags.join(", ")}]` : "";
    return `[${i + 1}] ${entry.title} (${entry.category}${tagStr})\n${entry.content}`;
  });

  return `--- Organizational Knowledge ---\n${sections.join("\n\n")}\n--- End Knowledge ---`;
}
