import type { ToolHandler } from "./toolRegistry.js";
import type { ToolCall } from "../types.js";
import { guardAction } from "../guards/actionGuard.js";
import pino from "pino";

const logger = pino({ name: "ai-tool-router" });

/**
 * Execute a tool call resolved from LLM output.
 * Validates the tool exists and passes through the action guard.
 */
export async function executeTool(
  call: ToolCall,
  registry: Map<string, ToolHandler>,
): Promise<{ success: boolean; result?: unknown; error?: string }> {
  const { tool: toolName, args } = call;

  // Guard check
  guardAction(toolName);

  const handler = registry.get(toolName);
  if (!handler) {
    logger.warn({ toolName }, "Unknown tool requested");
    return { success: false, error: `Unknown tool: ${toolName}` };
  }

  try {
    logger.info({ toolName, args }, "Executing tool");
    const result = await handler(args);
    logger.info({ toolName, success: true }, "Tool executed successfully");
    return { success: true, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Tool execution failed";
    logger.error({ toolName, err }, "Tool execution failed");
    return { success: false, error: message };
  }
}
