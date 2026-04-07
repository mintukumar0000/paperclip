import { getRedisClient } from "../redis/index.js";
import pino from "pino";

const logger = pino({ name: "vector-store" });

/**
 * Vector store for semantic memory.
 *
 * This implementation uses Redis for storing text + metadata.
 * For production semantic search, swap in pgvector or a dedicated
 * vector DB (Pinecone, Qdrant, Weaviate).
 *
 * The interface is stable — only the storage backend changes.
 */

export interface VectorEntry {
  id: string;
  companyId: string;
  text: string;
  metadata: Record<string, unknown>;
}

export const vectorStore = {
  /** Store a text entry for later retrieval */
  async store(entry: VectorEntry): Promise<void> {
    const redis = getRedisClient();
    const key = `vec:${entry.companyId}:${entry.id}`;
    await redis.hset(key, {
      text: entry.text,
      metadata: JSON.stringify(entry.metadata),
      companyId: entry.companyId,
    });
    // Add to company index for listing
    await redis.sadd(`vec-idx:${entry.companyId}`, entry.id);
    logger.debug({ id: entry.id }, "Vector entry stored");
  },

  /** Simple keyword-based semantic search (upgrade to embeddings for production) */
  async semanticSearch(
    companyId: string,
    query: string,
    limit = 5,
  ): Promise<VectorEntry[]> {
    const redis = getRedisClient();
    const ids = await redis.smembers(`vec-idx:${companyId}`);
    const results: VectorEntry[] = [];
    const lowerQuery = query.toLowerCase();

    for (const id of ids) {
      const data = await redis.hgetall(`vec:${companyId}:${id}`);
      if (data.text && data.text.toLowerCase().includes(lowerQuery)) {
        results.push({
          id,
          companyId,
          text: data.text,
          metadata: data.metadata ? JSON.parse(data.metadata) : {},
        });
        if (results.length >= limit) break;
      }
    }

    return results;
  },

  /** Delete a vector entry */
  async remove(companyId: string, id: string): Promise<void> {
    const redis = getRedisClient();
    await redis.del(`vec:${companyId}:${id}`);
    await redis.srem(`vec-idx:${companyId}`, id);
  },
};
