import type { Db } from "@paperclipai/db";
import type { AIExecutionContext, AIExecutionResult } from "./types.js";
import { buildPrompt } from "./prompts/promptBuilder.js";
import { getExecutionEngine } from "./router/adapterRouter.js";
import { createToolRegistry } from "./tools/toolRegistry.js";
import { executeTool } from "./tools/toolRouter.js";
import { trackTokenUsage } from "./telemetry/tokenTracker.js";
import { GuardedActionError } from "./guards/actionGuard.js";
import { recordSystemMetric, estimateTokenCostCents } from "./feedback/metricsEngine.js";
import { publishEvent } from "../events/eventPublisher.js";
import pino from "pino";

const logger = pino({ name: "ai-executor" });

/**
 * Execute a full AI reasoning + action cycle for an agent.
 *
 * Pipeline:
 *   Context → Prompt Builder → Adapter Router → LLM/Runtime → Tool Router → Result
 */
export async function executeAI(
  context: AIExecutionContext,
  db: Db,
): Promise<AIExecutionResult> {
  const { agent, issue } = context;

  let resolvedAdapterConfig = agent.adapterConfig;
  if (agent.adapterConfig) {
    try {
      const { secretService } = await import("../services/secrets.js");
      const secretsSvc = secretService(db);
      resolvedAdapterConfig = await secretsSvc.resolveAdapterConfigForRuntime(
        agent.companyId,
        agent.adapterConfig,
      );
    } catch (err) {
      logger.warn({ err, agentId: agent.id }, "Failed to resolve adapter env bindings for tool execution");
    }
  }

  logger.info(
    { runId: context.runId, agentId: agent.id, issueId: issue.id, runtime: agent.runtime },
    "AI execution started",
  );

  // Deterministic path: execute the declared tool directly and skip LLM generation.
  if (context.forcedToolCall) {
    const { tool: toolName } = context.forcedToolCall;
    const toolRegistry = createToolRegistry({
      db,
      companyId: agent.companyId,
      agentId: agent.id,
      adapterConfig: resolvedAdapterConfig,
    });

    try {
      const toolResult = await executeTool(context.forcedToolCall, toolRegistry);
      const serializedOutput =
        typeof toolResult.result === "string"
          ? toolResult.result
          : JSON.stringify(toolResult.result);

      await publishEvent("tool.executed" as any, {
        runId: context.runId,
        agentId: agent.id,
        companyId: agent.companyId,
        toolName,
        success: toolResult.success,
      });

      return {
        status: toolResult.success ? "tool_executed" : "failed",
        toolName,
        toolResult: toolResult.result,
        output: serializedOutput,
        error: toolResult.error,
      };
    } catch (err) {
      if (err instanceof GuardedActionError) {
        logger.warn({ action: toolName, reason: err.reason }, "Tool call blocked by guard");
        return {
          status: "guarded",
          toolName,
          error: err.message,
        };
      }
      throw err;
    }
  }

  const engine = getExecutionEngine(agent);

  // Runtime adapters handle their own reasoning
  if (engine.kind === "runtime") {
    try {
      const result = await engine.adapter.execute(context);
      await publishEvent("agent.run.completed", {
        runId: context.runId,
        agentId: agent.id,
        companyId: agent.companyId,
        status: result.status,
        engine: engine.adapter.name,
      });
      return {
        status: "completed",
        output: typeof result.output === "string" ? result.output : JSON.stringify(result.output),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Runtime execution failed";
      logger.error({ err, runtime: engine.adapter.name }, "Runtime adapter failed");
      return { status: "failed", error: message };
    }
  }

  // LLM path: build prompt → call LLM → optionally route tool calls
  const { prompt, systemPrompt, tools: toolDefs } = buildPrompt(context);

  await publishEvent("llm.prompt.sent" as any, {
    runId: context.runId,
    agentId: agent.id,
    companyId: agent.companyId,
    provider: agent.runtime ?? "openai",
    promptLength: prompt.length,
  });

  let llmResponse;
  try {
    llmResponse = await engine.adapter.generate({
      prompt,
      systemPrompt,
      tools: toolDefs,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "LLM generation failed";
    logger.error({ err, provider: engine.adapter.name }, "LLM generation failed");
    return { status: "failed", error: message };
  }

  await publishEvent("llm.response.received" as any, {
    runId: context.runId,
    agentId: agent.id,
    companyId: agent.companyId,
    provider: llmResponse.provider,
    model: llmResponse.model,
    hasToolCall: !!llmResponse.toolCall,
    inputTokens: llmResponse.usage?.inputTokens,
    outputTokens: llmResponse.usage?.outputTokens,
  });

  // Track token usage
  if (llmResponse.usage) {
    trackTokenUsage({
      runId: context.runId,
      agentId: agent.id,
      companyId: agent.companyId,
      provider: llmResponse.provider,
      model: llmResponse.model,
      inputTokens: llmResponse.usage.inputTokens,
      outputTokens: llmResponse.usage.outputTokens,
      timestamp: new Date(),
    });
  }

  // Handle tool calls
  if (llmResponse.toolCall) {
    const { tool: toolName, args: toolArgs } = llmResponse.toolCall;

    const toolRegistry = createToolRegistry({
      db,
      companyId: agent.companyId,
      agentId: agent.id,
      adapterConfig: resolvedAdapterConfig,
    });

    try {
      const toolResult = await executeTool(llmResponse.toolCall, toolRegistry);

      await publishEvent("tool.executed" as any, {
        runId: context.runId,
        agentId: agent.id,
        companyId: agent.companyId,
        toolName,
        success: toolResult.success,
      });

      try {
        await recordSystemMetric(db, {
          companyId: agent.companyId,
          sourceType: "tool_action",
          sourceId: `${context.runId}:${toolName}`,
          traffic: 1,
          conversions: toolResult.success ? 1 : 0,
          revenueCents: 0,
          taskSuccessRate: toolResult.success ? 1 : 0,
          costPerActionCents: estimateTokenCostCents(llmResponse.usage),
          metadata: {
            runId: context.runId,
            agentId: agent.id,
            toolName,
            success: toolResult.success,
          },
        });
      } catch (metricErr) {
        logger.warn({ err: metricErr, runId: context.runId, toolName }, "Failed to log tool action metric");
      }

      logger.info(
        { runId: context.runId, toolName, success: toolResult.success },
        "Tool execution complete",
      );

      return {
        status: toolResult.success ? "tool_executed" : "failed",
        toolName,
        toolResult: toolResult.result,
        output:
          typeof toolResult.result === "string"
            ? toolResult.result
            : JSON.stringify(toolResult.result),
        error: toolResult.error,
        usage: llmResponse.usage
          ? { ...llmResponse.usage, provider: llmResponse.provider, model: llmResponse.model }
          : undefined,
      };
    } catch (err) {
      if (err instanceof GuardedActionError) {
        logger.warn({ action: toolName, reason: err.reason }, "Tool call blocked by guard");
        return {
          status: "guarded",
          toolName,
          error: err.message,
        };
      }
      throw err;
    }
  }

  // Plain text response — task completed via reasoning
  await publishEvent("agent.run.completed", {
    runId: context.runId,
    agentId: agent.id,
    companyId: agent.companyId,
    status: "completed",
    engine: engine.adapter.name,
  });

  return {
    status: "completed",
    output: llmResponse.text,
    usage: llmResponse.usage
      ? { ...llmResponse.usage, provider: llmResponse.provider, model: llmResponse.model }
      : undefined,
  };
}
