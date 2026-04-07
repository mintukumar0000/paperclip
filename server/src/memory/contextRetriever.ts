import type { Db } from "@paperclipai/db";
import { memoryService } from "./memoryService.js";
import { vectorStore } from "./vectorStore.js";
import pino from "pino";

const logger = pino({ name: "context-retriever" });

/**
 * Retrieves relevant context for an agent before execution.
 * Combines structured memory, short-term cache, and semantic search.
 */
export function contextRetriever(db: Db) {
  const memorySvc = memoryService(db);

  return {
    async retrieveRelevantContext(params: {
      companyId: string;
      agentId: string;
      taskDescription: string;
    }): Promise<string> {
      const sections: string[] = [];

      // 1. Short-term memory (recent interactions)
      const recentContext = await memorySvc.getShortTerm(
        params.companyId,
        params.agentId,
        "last_context",
      );
      if (recentContext) {
        sections.push(`## Recent Context\n${recentContext}`);
      }

      // 2. Relevant structured memories
      const relevantMemories = await memorySvc.searchMemories(
        params.companyId,
        params.taskDescription,
        5,
      );
      if (relevantMemories.length > 0) {
        const items = relevantMemories
          .map((m) => `- [${m.type}] ${m.title}: ${m.content}`)
          .join("\n");
        sections.push(`## Company Knowledge\n${items}`);
      }

      // 3. Semantic search results
      const vectorResults = await vectorStore.semanticSearch(
        params.companyId,
        params.taskDescription,
        3,
      );
      if (vectorResults.length > 0) {
        const items = vectorResults.map((v) => `- ${v.text}`).join("\n");
        sections.push(`## Related Knowledge\n${items}`);
      }

      const context = sections.join("\n\n");
      logger.info(
        {
          agentId: params.agentId,
          memoriesFound: relevantMemories.length,
          vectorResults: vectorResults.length,
        },
        "Context retrieved for agent",
      );

      return context;
    },
  };
}
