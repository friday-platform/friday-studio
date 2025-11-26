import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PlatformBinaryName } from "../types";
import { getErrorMessage } from "./errors";
import { createLogger } from "./logger";
import { isMac, isWindows } from "./platform";

/**
 * Claude CLI Detection Utility
 * Discovers and validates Claude Code CLI installation across different platforms
 */

const logger = createLogger("ClaudeDetector");

/**
 * Check if file is executable
 */
function isExecutableFile(filePath: string): boolean {
  try {
    if (!fs.existsSync(filePath)) return false;

    const stats = fs.statSync(filePath);
    if (!stats.isFile()) return false;

    // Windows .cmd/.exe files are always executable
    if (isWindows()) return true;

    // Unix: check execute permission
    return (stats.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * Find Claude CLI executable path on the system
 * Tries multiple strategies to locate Claude Code CLI
 */
export function findClaudePath(): string | null {
  const { execSync } = require("node:child_process");

  // Common Claude CLI locations to check as fallback
  const commonClaudePaths: string[] = [
    "/opt/homebrew/bin/claude", // Homebrew on Apple Silicon
    "/usr/local/bin/claude", // Homebrew on Intel Mac or standard location
    "/usr/bin/claude", // System installation
    path.join(os.homedir(), ".npm-global/bin/claude"), // npm global
    path.join(os.homedir(), ".local/bin/claude"), // pipx/uv style installation
    path.join(os.homedir(), ".volta/bin/claude"), // Volta
    path.join(os.homedir(), ".asdf/shims/claude"), // asdf
  ];

  // First try to find via which/where command
  try {
    const claudeName: PlatformBinaryName = isWindows() ? "claude.cmd" : "claude";
    const cmd = isWindows() ? `where ${claudeName}` : `which ${claudeName}`;

    logger.info(`Running command: ${cmd}`);

    // On macOS, we need to run with a proper shell to get the full PATH
    const shellCmd = isMac()
      ? `/bin/bash -l -c "${cmd}"` // Use login shell to get full PATH
      : cmd;

    const execOptions = {
      encoding: "utf8" as BufferEncoding,
      stdio: ["ignore", "pipe", "pipe"] as const,
    };

    const result = execSync(shellCmd, execOptions);
    const resultStr = typeof result === "string" ? result.trim() : result.toString().trim();

    // On Windows, 'where' might return multiple paths, take the first one
    const lines = resultStr.split("\n");
    const claudePath = lines[0] ? lines[0].trim() : "";

    logger.info(`Found claude via command at: ${claudePath}`);

    if (isExecutableFile(claudePath)) {
      logger.info(`Claude path validated successfully: ${claudePath}`);
      return claudePath;
    }
  } catch (error) {
    logger.warn(`Could not find claude via command: ${getErrorMessage(error)}`);
  }

  // Fallback: Check common locations directly
  logger.info("Checking common Claude CLI locations...");
  for (const claudePath of commonClaudePaths) {
    try {
      if (isExecutableFile(claudePath)) {
        logger.info(`Found claude at common location: ${claudePath}`);
        return claudePath;
      }
    } catch {
      // Continue checking other paths
    }
  }

  logger.warn("Could not find claude in PATH or common locations");
  return null;
}
