import type { RuntimeAdapter, AIExecutionContext } from "../../types.js";
import { runCLI } from "../../runtime/cliRunner.js";
import pino from "pino";

const logger = pino({ name: "ai-codex-runtime" });

/**
 * Codex runtime adapter — runs tasks via the `codex` CLI.
 * Falls back to HTTP API if CODEX_API_URL is set.
 */
export class CodexRuntimeAdapter implements RuntimeAdapter {
  readonly name = "codex";

  async execute(context: AIExecutionContext): Promise<{ status: string; output: unknown }> {
    const prompt = [context.issue.title, context.issue.description].filter(Boolean).join("\n\n");

    const apiUrl = process.env.CODEX_API_URL;
    if (!apiUrl) {
      return this.executeCLI(prompt, context);
    }

    return this.executeHTTP(apiUrl, prompt, context);
  }

  private async executeCLI(
    prompt: string,
    context: AIExecutionContext,
  ): Promise<{ status: string; output: unknown }> {
    logger.info(
      { agentId: context.agent.id, issueId: context.issue.id },
      "Running Codex via CLI",
    );

    const safePrompt = prompt.replace(/"/g, '\\"');
    const result = await runCLI(`codex run "${safePrompt}"`, {
      timeoutMs: 300_000,
    });

    if (result.exitCode !== 0 && !result.stdout) {
      throw new Error(`Codex CLI failed (exit ${result.exitCode}): ${result.stderr}`);
    }

    logger.info({ agentId: context.agent.id }, "Codex CLI execution completed");

    return { status: "completed", output: result.stdout || result.stderr };
  }

  private async executeHTTP(
    baseUrl: string,
    prompt: string,
    context: AIExecutionContext,
  ): Promise<{ status: string; output: unknown }> {
    logger.info(
      { agentId: context.agent.id, issueId: context.issue.id },
      "Dispatching to Codex HTTP API",
    );

    const res = await fetch(`${baseUrl}/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.CODEX_API_KEY
          ? { Authorization: `Bearer ${process.env.CODEX_API_KEY}` }
          : {}),
      },
      body: JSON.stringify({
        task: context.issue.title,
        description: context.issue.description,
        context: context.memoryContext,
        agentId: context.agent.id,
        runId: context.runId,
      }),
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Codex API error ${res.status}: ${errorText}`);
    }

    const data = await res.json();
    logger.info({ agentId: context.agent.id }, "Codex HTTP execution completed");

    return { status: "completed", output: data };
  }
}
