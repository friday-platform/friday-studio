import type { ExecOptions } from "node:child_process";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { CONFIG } from "../config";
import { getErrorMessage } from "./errors";
import { isWindows } from "./platform";

const execAsync = promisify(exec);

/**
 * Process management utilities
 * Provides safe process execution and verification
 */

interface ProcessOptions {
  timeout?: number;
  maxRetries?: number;
  retryDelay?: number;
  checkFn?: () => Promise<boolean>;
}

/**
 * Wait for process state change
 */
async function waitForProcessState(
  processName: string,
  desiredState: boolean,
  options: ProcessOptions = {},
): Promise<boolean> {
  const timeout =
    options.timeout || (desiredState ? CONFIG.process.startTimeout : CONFIG.process.stopTimeout);
  const maxRetries = options.maxRetries || CONFIG.process.maxRetries;
  const retryDelay = options.retryDelay || CONFIG.process.retryDelay;
  const startTime = Date.now();

  for (let i = 0; i < maxRetries; i++) {
    if (Date.now() - startTime > timeout) {
      return false;
    }

    // Check process state
    const isRunning = options.checkFn
      ? await options.checkFn()
      : await isProcessRunning(processName);
    if (isRunning === desiredState) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, retryDelay));
  }

  return false;
}

/**
 * Wait for a process to start
 */
export async function waitForProcessToStart(
  processName: string,
  options: ProcessOptions = {},
): Promise<boolean> {
  return waitForProcessState(processName, true, options);
}

/**
 * Wait for a process to stop
 */
export async function waitForProcessToStop(
  processName: string,
  options: ProcessOptions = {},
): Promise<boolean> {
  return waitForProcessState(processName, false, options);
}

/**
 * Check if a process is running
 */
async function isProcessRunning(processName: string): Promise<boolean> {
  try {
    if (isWindows()) {
      // Use tasklist to check if process exists
      const result = await safeExec(`tasklist /FI "IMAGENAME eq ${processName}" 2>nul`, {
        encoding: "utf8",
        windowsHide: true,
      });
      return result.includes(processName);
    } else {
      // Use pgrep for Unix-like systems
      await safeExec(`pgrep -f "${processName}"`);
      return true;
    }
  } catch {
    return false;
  }
}

/**
 * Kill a process safely
 */
export async function killProcess(
  processName: string,
  options: ProcessOptions = {},
): Promise<boolean> {
  const { timeout = CONFIG.process.defaultTimeout } = options;

  try {
    if (isWindows()) {
      await safeExec(`taskkill /F /IM ${processName}`, { timeout });
    } else {
      await safeExec(`pkill -f "${processName}"`, { timeout });
    }

    // Wait for process to actually stop
    return await waitForProcessToStop(processName, { timeout });
  } catch (error) {
    console.error(`Failed to kill process ${processName}: ${getErrorMessage(error)}`);
    return false;
  }
}

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

// Backwards compatibility exports (will be removed)
export const safeExecAsync = safeExec;
export const safeExecSync = safeExec; // Now async, callers need to be updated
