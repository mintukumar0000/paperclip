import type { RuntimeAdapter, AIExecutionContext } from "../../types.js";
import { runCLI } from "../../runtime/cliRunner.js";
import pino from "pino";

const logger = pino({ name: "ai-claude-code-runtime" });

/**
 * Claude Code runtime adapter — runs tasks via the `claude` CLI.
 * Falls back to HTTP API if CLAUDE_CODE_API_URL is set.
 */
export class ClaudeCodeRuntimeAdapter implements RuntimeAdapter {
  readonly name = "claude_code";

  async execute(context: AIExecutionContext): Promise<{ status: string; output: unknown }> {
    const prompt = [context.issue.title, context.issue.description].filter(Boolean).join("\n\n");

    // Prefer CLI if available
    const apiUrl = process.env.CLAUDE_CODE_API_URL;
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
      "Running Claude Code via CLI",
    );

    // Use --print for non-interactive one-shot execution
    const safePrompt = prompt.replace(/"/g, '\\"');
    const model = (process.env.CLAUDE_CODE_MODEL ?? process.env.ANTHROPIC_MODEL ?? "").trim();
    const modelFlag = model ? ` --model "${model.replace(/"/g, '\\"')}"` : "";
    const claudeApiKey = (process.env.CLAUDE_CODE_API_KEY ?? "").trim();
    const env = claudeApiKey && !(process.env.ANTHROPIC_API_KEY ?? "").trim()
      ? { ANTHROPIC_API_KEY: claudeApiKey }
      : undefined;
    const result = await runCLI(`claude --print${modelFlag} "${safePrompt}"`, {
      timeoutMs: 300_000, // 5 min for coding tasks
      env,
    });

    if (result.exitCode !== 0 && !result.stdout) {
      throw new Error(`Claude Code CLI failed (exit ${result.exitCode}): ${result.stderr}`);
    }

    logger.info({ agentId: context.agent.id }, "Claude Code CLI execution completed");

    return { status: "completed", output: result.stdout || result.stderr };
  }

  private async executeHTTP(
    baseUrl: string,
    prompt: string,
    context: AIExecutionContext,
  ): Promise<{ status: string; output: unknown }> {
    logger.info(
      { agentId: context.agent.id, issueId: context.issue.id },
      "Dispatching to Claude Code HTTP API",
    );

    const claudeApiKey = (process.env.CLAUDE_CODE_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? "").trim();
    const model = (process.env.CLAUDE_CODE_MODEL ?? process.env.ANTHROPIC_MODEL ?? "").trim();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (claudeApiKey) {
      headers.Authorization = `Bearer ${claudeApiKey}`;
      headers["x-api-key"] = claudeApiKey;
    }

    const res = await fetch(`${baseUrl}/execute`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        task: context.issue.title,
        description: context.issue.description,
        context: context.memoryContext,
        agentId: context.agent.id,
        runId: context.runId,
        model: model || undefined,
      }),
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Claude Code API error ${res.status}: ${errorText}`);
    }

    const data = await res.json();
    logger.info({ agentId: context.agent.id }, "Claude Code HTTP execution completed");

    return { status: "completed", output: data };
  }
}
