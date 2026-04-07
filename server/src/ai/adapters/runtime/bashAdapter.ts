import type { RuntimeAdapter, AIExecutionContext } from "../../types.js";
import { runCLI } from "../../runtime/cliRunner.js";
import pino from "pino";

const logger = pino({ name: "ai-bash-runtime" });

/**
 * Bash runtime adapter — executes shell commands locally.
 * Always available. Uses the task description as the command to run.
 *
 * The agent's adapterConfig can customise:
 *   - cwd: working directory
 *   - timeoutMs: max execution time (default 60s)
 *   - shell: shell to use (default: bash -c)
 */
export class BashRuntimeAdapter implements RuntimeAdapter {
  readonly name = "bash";

  async execute(context: AIExecutionContext): Promise<{ status: string; output: unknown }> {
    const config = context.agent.adapterConfig ?? {};
    const cwd = (config.cwd as string) ?? process.cwd();
    const timeoutMs = (config.timeoutMs as number) ?? 60_000;

    // The issue description or title is the command to execute
    const command = context.issue.description ?? context.issue.title;

    if (!command) {
      throw new Error("No command provided — set issue title or description");
    }

    logger.info(
      { agentId: context.agent.id, issueId: context.issue.id, cmd: command.slice(0, 100) },
      "Executing bash command",
    );

    const result = await runCLI(command, { timeoutMs, cwd });

    const output = {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };

    if (result.exitCode !== 0) {
      logger.warn(
        { agentId: context.agent.id, exitCode: result.exitCode },
        "Bash command exited with non-zero code",
      );
      return { status: "failed", output };
    }

    logger.info({ agentId: context.agent.id }, "Bash execution completed");

    return { status: "completed", output };
  }
}
