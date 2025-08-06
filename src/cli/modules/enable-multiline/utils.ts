/**
 * Utility functions for terminal setup
 */

import { CommandResult } from "./types.ts";

/**
 * Execute a command and return results
 */
export async function execCommand(
  command: string,
  args: string[],
): Promise<CommandResult> {
  try {
    const cmd = new Deno.Command(command, {
      args,
      stdout: "piped",
      stderr: "piped",
    });

    const { stdout, stderr, code, success } = await cmd.output();

    return {
      stdout: new TextDecoder().decode(stdout),
      stderr: new TextDecoder().decode(stderr),
      code,
      success,
    };
  } catch (error) {
    return {
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      code: -1,
      success: false,
    };
  }
}

/**
 * Check if a file exists
 */
export async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a backup of a file
 */
export async function createBackup(
  sourcePath: string,
  backupSuffix: string = ".bak",
): Promise<string | null> {
  try {
    const backupPath = `${sourcePath}${backupSuffix}`;
    await Deno.copyFile(sourcePath, backupPath);
    return backupPath;
  } catch (error) {
    console.error(`Failed to create backup: ${error}`);
    return null;
  }
}

/**
 * Generate a unique backup suffix
 */
export function generateBackupSuffix(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `.backup-${timestamp}`;
}

/**
 * Format success message with color
 */
export function formatSuccessMessage(message: string): string {
  return `✅ ${message}`;
}

/**
 * Format error message with color
 */
export function formatErrorMessage(message: string): string {
  return `❌ ${message}`;
}

/**
 * Format warning message with color
 */
export function formatWarningMessage(message: string): string {
  return `⚠️  ${message}`;
}

/**
 * Format info message with color
 */
export function formatInfoMessage(message: string): string {
  return `ℹ️  ${message}`;
}

/**
 * Check if running in CI environment
 */
export function isCI(): boolean {
  return !!(
    Deno.env.get("CI") ||
    Deno.env.get("CONTINUOUS_INTEGRATION") ||
    Deno.env.get("GITHUB_ACTIONS") ||
    Deno.env.get("GITLAB_CI") ||
    Deno.env.get("CIRCLECI") ||
    Deno.env.get("TRAVIS")
  );
}

/**
 * Get home directory
 */
export function getHomeDir(): string {
  const homeDir = Deno.env.get("HOME") || Deno.env.get("USERPROFILE");
  if (!homeDir) {
    throw new Error("Unable to determine home directory");
  }
  return homeDir;
}
