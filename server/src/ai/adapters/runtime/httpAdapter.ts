import type { RuntimeAdapter, AIExecutionContext } from "../../types.js";
import pino from "pino";

const logger = pino({ name: "ai-http-runtime" });

/**
 * HTTP runtime adapter — delegates execution to an external webhook URL.
 * Always available. The target URL is configured via the agent's adapterConfig.
 *
 * adapterConfig:
 *   - httpUrl: the webhook endpoint to POST the task to (required)
 *   - httpHeaders: optional extra headers
 *   - httpTimeoutMs: request timeout (default 30s)
 */
export class HttpRuntimeAdapter implements RuntimeAdapter {
  readonly name = "http";

  async execute(context: AIExecutionContext): Promise<{ status: string; output: unknown }> {
    const config = context.agent.adapterConfig ?? {};
    const url = (config.httpUrl as string) ?? process.env.HTTP_RUNTIME_URL;
    const extraHeaders = (config.httpHeaders as Record<string, string>) ?? {};
    const timeoutMs = (config.httpTimeoutMs as number) ?? 30_000;

    if (!url) {
      throw new Error(
        "HTTP runtime requires a target URL — set agent adapterConfig.httpUrl or HTTP_RUNTIME_URL env var",
      );
    }

    logger.info(
      { agentId: context.agent.id, issueId: context.issue.id, url },
      "Dispatching to HTTP webhook",
    );

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...extraHeaders,
        },
        body: JSON.stringify({
          runId: context.runId,
          agentId: context.agent.id,
          companyId: context.agent.companyId,
          task: context.issue.title,
          description: context.issue.description,
          memory: context.memoryContext,
          tools: context.tools,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`HTTP runtime error ${res.status}: ${errorText}`);
      }

      const data = await res.json();

      logger.info({ agentId: context.agent.id }, "HTTP webhook execution completed");

      return { status: "completed", output: data };
    } finally {
      clearTimeout(timer);
    }
  }
}
