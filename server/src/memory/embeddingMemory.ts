import type { Db } from "@paperclipai/db";
import { aiLearningRecords, activityLog } from "@paperclipai/db";
import { and, eq, desc, sql } from "@paperclipai/db";
import pino from "pino";

const logger = pino({ name: "embedding-memory" });

/**
 * Lightweight embedding memory using OpenAI embeddings + PostgreSQL JSON storage.
 *
 * This avoids pgvector dependency while still providing real semantic search
 * via cosine similarity computed in application code. For <10k entries this
 * is fast enough; switch to pgvector for larger scale.
 */

interface MemoryEntry {
  id: string;
  companyId: string;
  category: "action_outcome" | "content_performance" | "decision_result" | "pricing_result" | "email_performance";
  text: string;
  embedding: number[] | null;
  metadata: Record<string, unknown>;
  score: number | null;
  createdAt: string;
}

const embeddingCache = new Map<string, number[]>();

async function getEmbedding(text: string): Promise<number[] | null> {
  const apiKey = (process.env.OPENAI_API_KEY ?? "").trim();
  if (!apiKey) return null;

  const cacheKey = text.slice(0, 200);
  if (embeddingCache.has(cacheKey)) return embeddingCache.get(cacheKey)!;

  const baseUrl = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").trim();

  const isOpenRouter = baseUrl.includes("openrouter.ai");
  if (isOpenRouter) {
    return hashEmbedding(text);
  }

  try {
    const response = await fetch(`${baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: text.slice(0, 8000),
      }),
    });

    if (!response.ok) {
      return hashEmbedding(text);
    }

    const data = (await response.json()) as Record<string, unknown>;
    const embeddingData = data.data as Array<{ embedding: number[] }> | undefined;
    const embedding = embeddingData?.[0]?.embedding;

    if (embedding && Array.isArray(embedding)) {
      embeddingCache.set(cacheKey, embedding);
      return embedding;
    }
  } catch (err) {
    logger.debug({ err }, "Embedding API call failed, using hash fallback");
  }

  return hashEmbedding(text);
}

function hashEmbedding(text: string): number[] {
  const dims = 64;
  const vec = new Array(dims).fill(0);
  const lower = text.toLowerCase();
  for (let i = 0; i < lower.length; i++) {
    const charCode = lower.charCodeAt(i);
    const idx = (charCode * (i + 1)) % dims;
    vec[idx] += 1.0 / (1 + i * 0.01);
  }
  const mag = Math.sqrt(vec.reduce((s: number, v: number) => s + v * v, 0)) || 1;
  return vec.map((v: number) => v / mag);
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    magA += a[i]! * a[i]!;
    magB += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB) || 1);
}

export async function storeMemory(
  db: Db,
  companyId: string,
  category: MemoryEntry["category"],
  text: string,
  metadata: Record<string, unknown>,
  score: number | null = null,
): Promise<void> {
  const embedding = await getEmbedding(text);

  await db.insert(aiLearningRecords).values({
    companyId,
    recordType: "insight",
    category: "memory",
    summary: text.slice(0, 500),
    details: {
      memoryCategory: category,
      embedding: embedding ? JSON.stringify(embedding) : null,
      ...metadata,
    },
    scores: score != null ? { relevance: score } : null,
  });

  logger.debug({ companyId, category, textLength: text.length }, "Memory stored");
}

export async function recallMemories(
  db: Db,
  companyId: string,
  query: string,
  limit = 10,
  category?: MemoryEntry["category"],
): Promise<MemoryEntry[]> {
  const queryEmbedding = await getEmbedding(query);

  const conditions = [
    eq(aiLearningRecords.companyId, companyId),
    eq(aiLearningRecords.recordType, "insight"),
    eq(aiLearningRecords.category, "memory"),
  ];

  if (category) {
    conditions.push(sql`${aiLearningRecords.details} ->> 'memoryCategory' = ${category}`);
  }

  const rows = await db
    .select()
    .from(aiLearningRecords)
    .where(and(...conditions))
    .orderBy(desc(aiLearningRecords.createdAt))
    .limit(200);

  const entries: MemoryEntry[] = rows.map((row) => {
    const details = (row.details ?? {}) as Record<string, unknown>;
    let embedding: number[] | null = null;
    const embeddingStr = details.embedding;
    if (typeof embeddingStr === "string") {
      try { embedding = JSON.parse(embeddingStr); } catch { /* ignore */ }
    }

    // Compute similarity score
    let similarity = 0;
    if (queryEmbedding && embedding) {
      similarity = cosineSimilarity(queryEmbedding, embedding);
    } else {
      const queryLower = query.toLowerCase();
      const summaryLower = (row.summary ?? "").toLowerCase();
      similarity = summaryLower.includes(queryLower) ? 0.8 : 0;
      const words = queryLower.split(/\s+/);
      const matchCount = words.filter((w) => summaryLower.includes(w)).length;
      similarity = Math.max(similarity, matchCount / Math.max(words.length, 1) * 0.6);
    }

    // Recency weighting: newer memories get boosted
    const ageMs = Date.now() - (row.createdAt?.getTime() ?? Date.now());
    const ageHours = ageMs / (60 * 60_000);
    const recencyScore = Math.max(0, 1 - (ageHours / (7 * 24))); // decays over 7 days

    // Composite score: 70% similarity + 30% recency
    const compositeScore = (similarity * 0.7) + (recencyScore * 0.3);

    return {
      id: row.id,
      companyId: row.companyId,
      category: (details.memoryCategory ?? "action_outcome") as MemoryEntry["category"],
      text: row.summary ?? "",
      embedding,
      metadata: details,
      score: compositeScore,
      createdAt: row.createdAt?.toISOString() ?? "",
    };
  });

  // Filter by similarity threshold and sort by composite score
  const SIMILARITY_THRESHOLD = 0.15;
  const filtered = entries.filter((e) => (e.score ?? 0) >= SIMILARITY_THRESHOLD);
  filtered.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return filtered.slice(0, limit);
}

// Record outcome of a decision action for future learning
export async function recordActionOutcome(
  db: Db,
  companyId: string,
  actionKey: string,
  success: boolean,
  context: Record<string, unknown>,
): Promise<void> {
  const text = `Action "${actionKey}" ${success ? "succeeded" : "failed"}. ` +
    `Context: ${JSON.stringify(context).slice(0, 300)}`;

  await storeMemory(db, companyId, "action_outcome", text, {
    actionKey,
    success,
    ...context,
  }, success ? 1.0 : -1.0);
}

// Record content post performance
export async function recordContentPerformance(
  db: Db,
  companyId: string,
  channel: string,
  title: string,
  posted: boolean,
  metrics: Record<string, unknown>,
): Promise<void> {
  const text = `Content on ${channel}: "${title.slice(0, 100)}" — ${posted ? "posted" : "failed"}. ` +
    `Metrics: ${JSON.stringify(metrics).slice(0, 200)}`;

  await storeMemory(db, companyId, "content_performance", text, {
    channel,
    title,
    posted,
    ...metrics,
  }, posted ? 0.5 : -0.5);
}

// Get past successes and failures for a specific action type
export async function getActionHistory(
  db: Db,
  companyId: string,
  actionKey: string,
  limit = 5,
): Promise<{ successes: string[]; failures: string[] }> {
  const memories = await recallMemories(db, companyId, `action ${actionKey}`, limit * 2, "action_outcome");

  const successes: string[] = [];
  const failures: string[] = [];

  for (const m of memories) {
    if (m.metadata.success === true) {
      successes.push(m.text);
    } else {
      failures.push(m.text);
    }
  }

  return {
    successes: successes.slice(0, limit),
    failures: failures.slice(0, limit),
  };
}

// Build context string for LLM from relevant memories
export async function buildMemoryContext(
  db: Db,
  companyId: string,
  query: string,
  maxEntries = 8,
): Promise<string> {
  const memories = await recallMemories(db, companyId, query, maxEntries);

  if (memories.length === 0) return "No relevant past memories found.";

  const lines = memories.map((m, i) =>
    `${i + 1}. [${m.category}] ${m.text} (relevance: ${(m.score ?? 0).toFixed(2)})`
  );

  return `## Relevant Past Memories (${memories.length} results)\n${lines.join("\n")}`;
}
