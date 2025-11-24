import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PlatformBinaryName } from "../types";
import { getErrorMessage } from "./errors";
import { createLogger } from "./logger";
import { isMac, isWindows } from "./platform";

/**
 * Node Detection Utility
 * Discovers and validates Node.js installation across different platforms
 */

const logger = createLogger("NodeDetector");

/**
 * Check if file is executable
 */
function isExecutableFile(filePath: string): boolean {
  try {
    if (!fs.existsSync(filePath)) return false;

    const stats = fs.statSync(filePath);
    if (!stats.isFile()) return false;

    // Windows .exe files are always executable
    if (isWindows()) return true;

    // Unix: check execute permission
    return (stats.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * Find Node executable path on the system
 * Tries multiple strategies to locate Node
 */
export function findNodePath(): string | null {
  // Import execSync locally for this synchronous utility
  const { execSync } = require("node:child_process");

  // Common Node locations to check as fallback
  const commonNodePaths: string[] = [
    "/opt/homebrew/bin/node", // Homebrew on Apple Silicon
    "/usr/local/bin/node", // Homebrew on Intel Mac or standard location
    "/usr/bin/node", // System installation
    path.join(os.homedir(), ".nvm/versions/node/*/bin/node"), // NVM (would need glob)
    path.join(os.homedir(), ".volta/bin/node"), // Volta
    path.join(os.homedir(), ".asdf/shims/node"), // asdf
  ];

  // First try to find via which/where command
  try {
    const nodeName: PlatformBinaryName = isWindows() ? "node.exe" : "node";
    const cmd = isWindows() ? `where ${nodeName}` : `which ${nodeName}`;

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
    const nodePath = lines[0] ? lines[0].trim() : "";

    logger.info(`Found node via command at: ${nodePath}`);

    if (isExecutableFile(nodePath)) {
      logger.info(`Node path validated successfully: ${nodePath}`);
      return nodePath;
    }
  } catch (error) {
    logger.warn(`Could not find node via command: ${getErrorMessage(error)}`);
  }

  // Fallback: Check common locations directly
  logger.info("Checking common Node locations...");
  for (const nodePath of commonNodePaths) {
    try {
      // Handle glob patterns (for nvm)
      if (nodePath.includes("*")) {
        continue; // Skip glob patterns for now
      }

      if (isExecutableFile(nodePath)) {
        logger.info(`Found node at common location: ${nodePath}`);
        return nodePath;
      }
    } catch {
      // Continue checking other paths
    }
  }

  logger.warn("Could not find node in PATH or common locations");
  return null;
}
