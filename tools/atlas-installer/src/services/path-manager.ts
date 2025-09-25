import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { IPCResult } from "../types";
import { getErrorMessage } from "../utils/errors";
import { createLogger } from "../utils/logger";
import { isMac, isWindows } from "../utils/platform";
import { safeExec } from "../utils/process";
import { escapePowerShell } from "../utils/security";

/**
 * PATH management utilities
 * Handles adding Atlas to system PATH and creating shortcuts
 */

const logger = createLogger("PathManager");

/**
 * Add to system PATH on Windows
 */
export async function addToSystemPath(directory: string): Promise<IPCResult> {
  if (!isWindows()) {
    return { success: false, error: "addToSystemPath is only supported on Windows" };
  }
  try {
    await addToWindowsPath(directory);
    return { success: true, message: "Added to Windows system PATH" };
  } catch (err) {
    return { success: false, error: `Failed to add to system PATH: ${getErrorMessage(err)}` };
  }
}

/**
 * Add to shell profiles on macOS
 */
export async function addToShellProfiles(_directory: string): Promise<IPCResult> {
  if (!isMac()) {
    return { success: false, error: "addToShellProfiles is only supported on macOS" };
  }
  return setupMacOSPath();
}

/**
 * Add directory to Windows PATH
 */
async function addToWindowsPath(directory: string): Promise<void> {
  logger.info(`Adding ${directory} to Windows PATH`);

  const escapedDir = escapePowerShell(directory);
  const psCommand = `
      $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
      if ($userPath -notlike "*${escapedDir}*") {
        [Environment]::SetEnvironmentVariable('Path', $userPath + ';${escapedDir}', 'User')
        $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
      }
    `.trim();

  try {
    await safeExec(`powershell -Command "${psCommand}"`, { windowsHide: true });
    logger.info("Added to Windows PATH successfully");
  } catch (error) {
    logger.error("Failed to add to Windows PATH", error);
    throw error;
  }
}

/**
 * Setup macOS PATH
 */
function setupMacOSPath(): IPCResult {
  try {
    const homeDir = os.homedir();

    // Add to shell configuration files
    const exportLine = `export PATH="$HOME/.atlas/bin:$PATH"`;
    const shellConfigs = [
      path.join(homeDir, ".zshrc"),
      path.join(homeDir, ".bashrc"),
      path.join(homeDir, ".bash_profile"),
    ];

    let configsUpdated = 0;

    for (const configFile of shellConfigs) {
      try {
        // Create file if it doesn't exist
        if (!fs.existsSync(configFile)) {
          fs.writeFileSync(configFile, "");
        }

        // Read existing content
        const content = fs.readFileSync(configFile, "utf8");

        // Check if already added
        if (content.includes(".atlas/bin")) {
          logger.info(`Path already configured in ${configFile}`);
          continue;
        }

        // Add export line
        const newContent = content.endsWith("\n")
          ? content + exportLine + "\n"
          : content + "\n" + exportLine + "\n";
        fs.writeFileSync(configFile, newContent);
        logger.info(`Added Atlas to PATH in ${configFile}`);
        configsUpdated++;
      } catch (err) {
        logger.warn(`Could not update ${configFile}: ${getErrorMessage(err)}`);
      }
    }

    if (configsUpdated === 0) {
      logger.info("Atlas already in PATH or no shell configs found");
    }

    return {
      success: true,
      message:
        "Atlas has been added to your PATH.\n\n" +
        "Please restart your terminal or run:\n" +
        "source ~/.zshrc (for zsh)\n" +
        "source ~/.bashrc (for bash)",
    };
  } catch (err) {
    const message = getErrorMessage(err);
    logger.error("Failed to setup macOS PATH", err);
    return { success: false, error: `Failed to setup macOS PATH: ${message}` };
  }
}
