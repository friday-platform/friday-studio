/**
 * Built-in "bash" tool for code agents.
 * Injected into the MCP tools dict so WASM agents can shell out via ctx.tools.call("bash", {...}).
 */

import { execFile } from "node:child_process";
import process from "node:process";
import { jsonSchema, tool } from "ai";

const DEFAULT_TIMEOUT_MS = 30_000;

export interface BashToolInput {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeout_ms?: number;
}

export interface BashToolOutput {
  stdout: string;
  stderr: string;
  exit_code: number;
}

/** Creates the built-in bash tool matching the Vercel AI SDK Tool interface. */
export function createBashTool() {
  return tool({
    description: "Execute a bash command and return stdout, stderr, and exit code.",
    inputSchema: jsonSchema<BashToolInput>({
      type: "object",
      properties: {
        command: { type: "string", description: "Bash command to execute" },
        cwd: { type: "string", description: "Working directory" },
        env: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Environment variables to set",
        },
        timeout_ms: { type: "number", description: "Timeout in milliseconds (default 30000)" },
      },
      required: ["command"],
    }),
    execute: (input): Promise<BashToolOutput> => {
      const timeoutMs = input.timeout_ms ?? DEFAULT_TIMEOUT_MS;

      // Merge agent env on top of process env (agent takes precedence)
      const mergedEnv = input.env ? { ...process.env, ...input.env } : process.env;

      return new Promise<BashToolOutput>((resolve) => {
        execFile(
          "/bin/bash",
          ["-c", input.command],
          {
            cwd: input.cwd,
            env: mergedEnv,
            timeout: timeoutMs,
            maxBuffer: 10 * 1024 * 1024, // 10 MB
          },
          (error, stdout, stderr) => {
            if (error) {
              // execFile sets error.code to the exit code on non-zero exit,
              // and error.killed / error.signal on timeout/kill
              const exitCode =
                typeof error.code === "number"
                  ? error.code
                  : error.killed || error.signal
                    ? 124 // conventional timeout exit code
                    : 1;

              resolve({
                stdout: stdout ?? "",
                stderr: stderr ?? error.message,
                exit_code: exitCode,
              });
              return;
            }

            resolve({ stdout: stdout ?? "", stderr: stderr ?? "", exit_code: 0 });
          },
        );
      });
    },
  });
}
