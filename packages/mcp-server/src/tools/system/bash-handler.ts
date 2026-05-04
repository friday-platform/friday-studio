/**
 * Pure bash-execution handler — the work the `bash` tool actually does,
 * extracted from the MCP tool registration so it can be invoked from
 * either path:
 *
 *   - In-process: the MCP `bash` tool calls this directly (legacy path,
 *     kept as a fallback for environments without NATS).
 *   - Via NATS: a tool worker registered with `registerToolWorker(nc,
 *     "bash", executeBash)` handles the dispatched envelope. When the
 *     worker eventually moves into a sandboxed runtime (Docker /
 *     Firecracker), only the worker registration site changes — the
 *     handler signature stays stable.
 */

import { z } from "zod";

const MAX_OUTPUT_LENGTH = 30_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

export const BashArgsSchema = z.object({
  command: z.string(),
  timeout: z.number().min(0).max(MAX_TIMEOUT_MS).optional(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
});
export type BashArgs = z.infer<typeof BashArgsSchema>;

export interface BashResult {
  title: string;
  output: string;
  metadata: { exitCode: number; stdout: string; stderr: string; truncated: boolean };
}

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_LENGTH) return text;
  return `${text.substring(0, MAX_OUTPUT_LENGTH)}\n\n... (output truncated due to length)`;
}

export async function executeBash(
  args: BashArgs,
  opts?: { abortSignal?: AbortSignal },
): Promise<BashResult> {
  const { command, cwd, env } = args;
  const timeout = Math.min(args.timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const effectiveCwd = cwd ?? Deno.cwd();
  const mergedEnv = env ? { ...Deno.env.toObject(), ...env } : undefined;

  // Compose the timeout-based controller with any caller-supplied abort. The
  // child process gets killed on whichever fires first.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  let externalAbortHandler: (() => void) | undefined;
  if (opts?.abortSignal) {
    if (opts.abortSignal.aborted) {
      controller.abort(opts.abortSignal.reason);
    } else {
      externalAbortHandler = () => controller.abort(opts.abortSignal?.reason);
      opts.abortSignal.addEventListener("abort", externalAbortHandler, { once: true });
    }
  }

  try {
    const cmd = new Deno.Command("bash", {
      args: ["-c", command],
      cwd: effectiveCwd,
      env: mergedEnv,
      stdout: "piped",
      stderr: "piped",
      signal: controller.signal,
    });
    const proc = cmd.spawn();
    const { code, stdout, stderr } = await proc.output();

    clearTimeout(timeoutId);

    const stdoutText = new TextDecoder().decode(stdout);
    const stderrText = new TextDecoder().decode(stderr);
    const truncatedStdout = truncate(stdoutText);
    const truncatedStderr = truncate(stderrText);

    return {
      title: command,
      output: [
        "<stdout>",
        truncatedStdout,
        "</stdout>",
        "<stderr>",
        truncatedStderr,
        "</stderr>",
      ].join("\n"),
      metadata: {
        exitCode: code,
        stdout: truncatedStdout,
        stderr: truncatedStderr,
        truncated: stdoutText.length > MAX_OUTPUT_LENGTH || stderrText.length > MAX_OUTPUT_LENGTH,
      },
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      // Distinguish caller cancellation from timeout — caller-aborted commands
      // should surface as a generic abort, not a timeout message.
      if (opts?.abortSignal?.aborted) {
        throw new Error(`Command aborted: ${command}`);
      }
      throw new Error(`Command timed out after ${timeout}ms: ${command}`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    if (externalAbortHandler) opts?.abortSignal?.removeEventListener("abort", externalAbortHandler);
  }
}
