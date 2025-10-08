import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// @ts-expect-error - CommonJS module without type definitions
import createShortcut = require("create-desktop-shortcuts");

import { createLogger } from "./logger";

const logger = createLogger("WindowsShortcuts");

/**
 * Create Start Menu shortcut for Atlas Web Client on Windows
 */
export async function createStartMenuShortcut(): Promise<void> {
  try {
    // Point to the Atlas Web Client executable, not the service binary
    const webClientPath = path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
      "Programs",
      "Atlas Web Client",
      "Atlas Web Client.exe",
    );

    // Check if web client is installed
    if (!fs.existsSync(webClientPath)) {
      logger.warn(`Atlas Web Client not found at ${webClientPath}, skipping shortcut creation`);
      return;
    }

    const success = createShortcut({
      windows: {
        filePath: webClientPath,
        outputPath: path.join(
          os.homedir(),
          "AppData/Roaming/Microsoft/Windows/Start Menu/Programs",
        ),
        name: "Atlas Web Client",
        comment: "Atlas AI Agent Orchestration Platform",
        icon: webClientPath,
      },
    });

    if (success) {
      logger.info("Start Menu shortcut for Atlas Web Client created successfully");
    } else {
      logger.warn("Failed to create Start Menu shortcut for Atlas Web Client");
    }
  } catch (error) {
    // Shortcut creation is non-critical
    logger.warn(`Error creating shortcut: ${error}`);
  }
}

/**
 * Remove Start Menu shortcut for Atlas Web Client on Windows
 */
export function removeStartMenuShortcut(): void {
  const shortcutPath = path.join(
    os.homedir(),
    "AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Atlas Web Client.lnk",
  );

  try {
    fs.unlinkSync(shortcutPath);
    logger.info("Start Menu shortcut removed");
  } catch {
    // Shortcut might not exist or removal might fail - both are non-critical
  }
}
