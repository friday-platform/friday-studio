import type { ExecOptions } from "node:child_process";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { CONFIG } from "../config";

const execAsync = promisify(exec);

/**
 * Process management utilities
 * Provides safe process execution
 */

/**
 * Format execution error with stdout/stderr
 */
function formatExecError(command: string, error: unknown): Error {
  const errorWithOutput = error as Error & {
    stderr?: Buffer | string;
    stdout?: Buffer | string;
    message: string;
  };

  const stderr = errorWithOutput.stderr ? errorWithOutput.stderr.toString() : "";
  const stdout = errorWithOutput.stdout ? errorWithOutput.stdout.toString() : "";
  const message = errorWithOutput.message || String(error);

  const parts = [`Command failed: ${command}`];
  if (stderr) parts.push(`Stderr: ${stderr}`);
  if (stdout) parts.push(`Stdout: ${stdout}`);
  if (!stderr && !stdout) parts.push(`Error: ${message}`);

  return new Error(parts.join("\n"));
}

/**
 * Safe execution of shell commands with proper error handling
 * Consolidates all exec operations into a single async function
 */
export async function safeExec(command: string, options: ExecOptions = {}): Promise<string> {
  const timeout = options.timeout || CONFIG.process.defaultTimeout;

  try {
    const result = await execAsync(command, {
      ...options,
      encoding: options.encoding || "utf8",
      timeout,
    });
    return (typeof result.stdout === "string" ? result.stdout : result.stdout?.toString()) || "";
  } catch (error) {
    throw formatExecError(command, error);
  }
}
