import type { Db } from "@paperclipai/db";
import { memories } from "@paperclipai/db";
import { eq, and, desc } from "@paperclipai/db";
import { getRedisClient } from "../redis/index.js";
import pino from "pino";

const logger = pino({ name: "memory-service" });
const CACHE_TTL = 3600; // 1 hour

export type MemoryType = "experiment" | "decision" | "knowledge" | "observation";

export function memoryService(db: Db) {
  return {
    /** Store a memory entry (structured, persisted to Postgres) */
    async storeMemory(params: {
      companyId: string;
      agentId?: string;
      type: MemoryType;
      title: string;
      content: string;
      metadata?: Record<string, unknown>;
    }) {
      const [row] = await db
        .insert(memories)
        .values({
          companyId: params.companyId,
          agentId: params.agentId,
          type: params.type,
          title: params.title,
          content: params.content,
          metadata: params.metadata ?? {},
        })
        .returning();

      // Also cache in Redis for short-term retrieval
      const redis = getRedisClient();
      const key = `memory:${params.companyId}:${row.id}`;
      await redis.setex(key, CACHE_TTL, JSON.stringify(row));

      logger.info({ id: row.id, type: params.type }, "Memory stored");
      return row;
    },

    /** Store short-term memory (Redis only, auto-expires) */
    async storeShortTerm(params: {
      companyId: string;
      agentId: string;
      key: string;
      value: string;
      ttlSeconds?: number;
    }) {
      const redis = getRedisClient();
      const redisKey = `stm:${params.companyId}:${params.agentId}:${params.key}`;
      await redis.setex(redisKey, params.ttlSeconds ?? 1800, params.value);
      logger.debug({ key: params.key, agentId: params.agentId }, "Short-term memory stored");
    },

    /** Retrieve short-term memory */
    async getShortTerm(companyId: string, agentId: string, key: string): Promise<string | null> {
      const redis = getRedisClient();
      return redis.get(`stm:${companyId}:${agentId}:${key}`);
    },

    /** List structured memories for a company, optionally filtered */
    async listMemories(companyId: string, opts?: { type?: MemoryType; limit?: number }) {
      const conditions = [eq(memories.companyId, companyId)];
      if (opts?.type) conditions.push(eq(memories.type, opts.type));

      return db
        .select()
        .from(memories)
        .where(and(...conditions))
        .orderBy(desc(memories.createdAt))
        .limit(opts?.limit ?? 50);
    },

    /** Retrieve memories by keyword match in title/content */
    async searchMemories(companyId: string, query: string, limit = 10) {
      // Simple text search - can be upgraded to pg_trgm or full-text later
      const results = await db
        .select()
        .from(memories)
        .where(eq(memories.companyId, companyId))
        .orderBy(desc(memories.relevanceScore), desc(memories.createdAt))
        .limit(limit);

      // Filter by keyword match
      const lower = query.toLowerCase();
      return results.filter(
        (m) =>
          m.title.toLowerCase().includes(lower) ||
          m.content.toLowerCase().includes(lower),
      );
    },
  };
}
