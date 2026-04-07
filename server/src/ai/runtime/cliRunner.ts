// ---------------------------------------------------------------------------
// CLI Runner — shared utility for CLI-based runtime adapters
// ---------------------------------------------------------------------------

import { exec } from "node:child_process";
import pino from "pino";

const logger = pino({ name: "cli-runner" });

export interface CLIRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run a CLI command with a timeout and return stdout.
 * Used by Claude Code, Codex, Cursor, and Bash adapters.
 */
export function runCLI(
  cmd: string,
  options: { timeoutMs?: number; cwd?: string; env?: Record<string, string> } = {},
): Promise<CLIRunResult> {
  const timeoutMs = options.timeoutMs ?? 120_000; // 2 min default

  logger.info({ cmd: cmd.slice(0, 200), timeoutMs }, "Running CLI command");

  return new Promise((resolve, reject) => {
    const child = exec(
      cmd,
      {
        maxBuffer: 1024 * 1024, // 1MB
        timeout: timeoutMs,
        cwd: options.cwd,
        env: options.env ? { ...process.env, ...options.env } : undefined,
      },
      (err, stdout, stderr) => {
        if (err && (err as any).killed) {
          logger.warn({ cmd: cmd.slice(0, 100) }, "CLI command timed out");
          resolve({ stdout: stdout ?? "", stderr: stderr ?? "Command timed out", exitCode: 124 });
          return;
        }

        if (err) {
          const exitCode = (err as any).code ?? 1;
          logger.warn({ cmd: cmd.slice(0, 100), exitCode, stderr: stderr?.slice(0, 200) }, "CLI command failed");
          resolve({ stdout: stdout ?? "", stderr: stderr ?? err.message, exitCode: typeof exitCode === "number" ? exitCode : 1 });
          return;
        }

        logger.info({ cmd: cmd.slice(0, 100), stdoutLen: stdout.length }, "CLI command succeeded");
        resolve({ stdout, stderr: stderr ?? "", exitCode: 0 });
      },
    );
  });
}
