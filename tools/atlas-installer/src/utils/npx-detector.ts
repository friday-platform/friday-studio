import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PlatformBinaryName } from "../types";
import { getErrorMessage } from "./errors";
import { createLogger } from "./logger";
import { isMac, isWindows } from "./platform";

/**
 * NPX Detection Utility
 * Discovers and validates NPX installation across different platforms
 */

const logger = createLogger("NPXDetector");

/**
 * Check if file is executable
 */
function isExecutableFile(filePath: string): boolean {
  try {
    if (!fs.existsSync(filePath)) return false;

    const stats = fs.statSync(filePath);
    if (!stats.isFile()) return false;

    // Windows .cmd files are always executable
    if (isWindows()) return true;

    // Unix: check execute permission
    return (stats.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * Find NPX executable path on the system
 * Tries multiple strategies to locate NPX
 * Note: This function remains synchronous for compatibility
 */
export function findNpxPath(): string | null {
  // Import execSync locally for this synchronous utility
  const { execSync } = require("node:child_process");

  // Common NPX locations to check as fallback
  const commonNpxPaths: string[] = [
    "/opt/homebrew/bin/npx", // Homebrew on Apple Silicon
    "/usr/local/bin/npx", // Homebrew on Intel Mac or standard location
    "/usr/bin/npx", // System installation
    path.join(os.homedir(), ".nvm/versions/node/*/bin/npx"), // NVM (would need glob)
    path.join(os.homedir(), ".volta/bin/npx"), // Volta
    path.join(os.homedir(), ".asdf/shims/npx"), // asdf
  ];

  // First try to find via which/where command
  try {
    // On Windows, look for npx.cmd which is the actual executable
    const npxName: PlatformBinaryName = isWindows() ? "npx.cmd" : "npx";
    const cmd = isWindows() ? `where ${npxName}` : `which ${npxName}`;

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
    const npxPath = lines[0] ? lines[0].trim() : "";

    logger.info(`Found npx via command at: ${npxPath}`);

    if (isExecutableFile(npxPath)) {
      logger.info(`NPX path validated successfully: ${npxPath}`);
      return npxPath;
    }
  } catch (error) {
    logger.warn(`Could not find npx via command: ${getErrorMessage(error)}`);
  }

  // Fallback: Check common locations directly
  logger.info("Checking common NPX locations...");
  for (const npxPath of commonNpxPaths) {
    try {
      // Handle glob patterns (for nvm)
      if (npxPath.includes("*")) {
        continue; // Skip glob patterns for now
      }

      if (isExecutableFile(npxPath)) {
        logger.info(`Found npx at common location: ${npxPath}`);
        return npxPath;
      }
    } catch {
      // Continue checking other paths
    }
  }

  logger.warn("Could not find npx in PATH or common locations");
  return null;
}
