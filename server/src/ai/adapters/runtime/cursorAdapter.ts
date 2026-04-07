import type { RuntimeAdapter, AIExecutionContext } from "../../types.js";
import { runCLI } from "../../runtime/cliRunner.js";
import pino from "pino";

const logger = pino({ name: "ai-cursor-runtime" });

/**
 * Cursor runtime adapter — delegates to the Cursor CLI agent runner.
 */
export class CursorRuntimeAdapter implements RuntimeAdapter {
  readonly name = "cursor";

  async execute(context: AIExecutionContext): Promise<{ status: string; output: unknown }> {
    const prompt = [context.issue.title, context.issue.description].filter(Boolean).join("\n\n");

    logger.info(
      { agentId: context.agent.id, issueId: context.issue.id },
      "Running Cursor CLI agent",
    );

    const safePrompt = prompt.replace(/"/g, '\\"');
    const result = await runCLI(`cursor --run-agent "${safePrompt}"`, {
      timeoutMs: 300_000,
    });

    if (result.exitCode !== 0 && !result.stdout) {
      throw new Error(`Cursor CLI failed (exit ${result.exitCode}): ${result.stderr}`);
    }

    logger.info({ agentId: context.agent.id }, "Cursor CLI execution completed");

    return { status: "completed", output: result.stdout || result.stderr };
  }
}
