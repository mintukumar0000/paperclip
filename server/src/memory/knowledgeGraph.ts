import type { Db } from "@paperclipai/db";
import { memories } from "@paperclipai/db";
import { eq, and } from "@paperclipai/db";
import pino from "pino";

const logger = pino({ name: "knowledge-graph" });

interface KnowledgeNode {
  id: string;
  type: string;
  title: string;
  connections: string[];
}

/**
 * Simple knowledge graph backed by memory entries.
 * Nodes are memories; edges are inferred from shared metadata keys.
 */
export function knowledgeGraph(db: Db) {
  return {
    /** Build a graph of knowledge nodes for a company */
    async buildGraph(companyId: string): Promise<KnowledgeNode[]> {
      const allMemories = await db
        .select()
        .from(memories)
        .where(eq(memories.companyId, companyId));

      const nodes: KnowledgeNode[] = allMemories.map((m) => ({
        id: m.id,
        type: m.type,
        title: m.title,
        connections: [],
      }));

      // Connect nodes that share metadata tags
      for (let i = 0; i < nodes.length; i++) {
        const mI = allMemories[i];
        const tagsI = extractTags(mI.metadata);
        for (let j = i + 1; j < nodes.length; j++) {
          const tagsJ = extractTags(allMemories[j].metadata);
          if (tagsI.some((t) => tagsJ.includes(t))) {
            nodes[i].connections.push(nodes[j].id);
            nodes[j].connections.push(nodes[i].id);
          }
        }
      }

      logger.info({ companyId, nodeCount: nodes.length }, "Knowledge graph built");
      return nodes;
    },

    /** Query graph for nodes related to a topic */
    async queryRelated(companyId: string, topic: string): Promise<KnowledgeNode[]> {
      const graph = await this.buildGraph(companyId);
      const lower = topic.toLowerCase();
      const matches = graph.filter((n) => n.title.toLowerCase().includes(lower));
      // Include connected nodes
      const connectedIds = new Set(matches.flatMap((m) => m.connections));
      const related = graph.filter((n) => connectedIds.has(n.id));
      return [...matches, ...related];
    },
  };
}

function extractTags(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== "object") return [];
  const m = metadata as Record<string, unknown>;
  if (Array.isArray(m.tags)) return m.tags.filter((t): t is string => typeof t === "string");
  return [];
}
