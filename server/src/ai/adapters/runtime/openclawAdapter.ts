import type { RuntimeAdapter, AIExecutionContext } from "../../types.js";
import pino from "pino";

const logger = pino({ name: "ai-openclaw-runtime" });

/**
 * OpenClaw runtime adapter — delegates execution to the OpenClaw
 * autonomous agent platform via HTTP API.
 */
export class OpenClawRuntimeAdapter implements RuntimeAdapter {
  readonly name = "openclaw";

  async execute(context: AIExecutionContext): Promise<{ status: string; output: unknown }> {
    const baseUrl = process.env.OPENCLAW_URL ?? process.env.OPENCLAW_API_URL ?? "https://api.openclaw.ai";
    const apiKey = process.env.OPENCLAW_API_KEY;

    logger.info(
      { agentId: context.agent.id, issueId: context.issue.id, baseUrl },
      "Dispatching to OpenClaw runtime",
    );

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const res = await fetch(`${baseUrl}/execute`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        agentId: context.agent.id,
        task: context.issue.title,
        description: context.issue.description,
        memory: context.memoryContext,
        tools: context.tools,
        runId: context.runId,
      }),
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`OpenClaw API error ${res.status}: ${errorText}`);
    }

    const data = await res.json();

    logger.info(
      { agentId: context.agent.id, status: "completed" },
      "OpenClaw execution completed",
    );

    return { status: "completed", output: data };
  }
}
