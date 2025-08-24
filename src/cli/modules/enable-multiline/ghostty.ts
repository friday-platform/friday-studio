/**
 * Ghostty terminal setup implementation
 */

import { dirname, join } from "@std/path";
import type { SetupResult } from "./types.ts";
import { fileExists, getHomeDir } from "./utils.ts";

/**
 * Get possible Ghostty config paths
 */
function getGhosttyConfigPaths(): string[] {
  const home = getHomeDir();
  const xdgConfigHome = Deno.env.get("XDG_CONFIG_HOME");

  const paths: string[] = [];

  // XDG config path
  if (xdgConfigHome) {
    paths.push(join(xdgConfigHome, "ghostty", "config"));
  } else {
    paths.push(join(home, ".config", "ghostty", "config"));
  }

  // macOS-specific path
  if (Deno.build.os === "darwin") {
    paths.push(join(home, "Library", "Application Support", "com.mitchellh.ghostty", "config"));
  }

  return paths;
}

/**
 * Find existing Ghostty config or determine where to create it
 */
async function findGhosttyConfig(): Promise<{ path: string; exists: boolean }> {
  const paths = getGhosttyConfigPaths();

  // Check for existing config
  for (const path of paths) {
    if (await fileExists(path)) {
      return { path, exists: true };
    }
  }

  // Return first path as the location to create new config
  const defaultPath = paths[0];
  if (!defaultPath) {
    throw new Error("Could not determine Ghostty config path");
  }
  return { path: defaultPath, exists: false };
}

/**
 * Create a backup of Ghostty config
 */
async function createGhosttyBackup(configPath: string): Promise<string | undefined> {
  const backupPath = `${configPath}.bak-${Date.now()}`;

  try {
    await Deno.copyFile(configPath, backupPath);
    return backupPath;
  } catch (error) {
    console.error("Failed to create Ghostty backup:", error);
    return undefined;
  }
}

/**
 * Check if Shift+Enter keybinding already exists in config
 */
function hasShiftEnterKeybinding(content: string): boolean {
  // Check for various forms of the keybinding
  return (
    content.includes("shift+enter") ||
    content.includes("shift+return") ||
    content.includes("Shift+Enter") ||
    content.includes("Shift+Return")
  );
}

/**
 * Setup Ghostty for multi-line input
 */
export async function setupGhostty(): Promise<SetupResult> {
  try {
    // Find or determine config path
    const { path: configPath, exists: configExists } = await findGhosttyConfig();

    let content = "";
    let backupPath: string | undefined;

    if (configExists) {
      // Read existing config
      content = await Deno.readTextFile(configPath);

      // Check if keybinding already exists
      if (hasShiftEnterKeybinding(content)) {
        return { success: true };
      }

      // Create backup
      backupPath = await createGhosttyBackup(configPath);
      if (!backupPath) {
        return { success: false, error: "Failed to create backup of Ghostty config" };
      }
    } else {
      // Create config directory if it doesn't exist
      const configDir = dirname(configPath);
      try {
        await Deno.stat(configDir);
      } catch {
        await Deno.mkdir(configDir, { recursive: true });
      }
    }

    // Add keybinding to config
    let updatedContent = content;

    // Add newline if content doesn't end with one
    if (content && !content.endsWith("\n")) {
      updatedContent += "\n";
    }

    // Add the keybinding
    // The text:\\n sends a literal newline character
    updatedContent += "keybind = shift+enter=text:\\n\n";

    // Write updated config
    await Deno.writeTextFile(configPath, updatedContent);

    return { success: true, backupPath };
  } catch (error) {
    console.error("Ghostty setup failed:", error);

    return {
      success: false,
      error: `Failed to configure Ghostty: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/**
 * Restore Ghostty from backup
 */
export async function restoreGhostty(backupPath: string): Promise<SetupResult> {
  if (!(await fileExists(backupPath))) {
    return { success: false, error: "Backup file no longer exists" };
  }

  try {
    const { path: configPath } = await findGhosttyConfig();
    await Deno.copyFile(backupPath, configPath);

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: `Failed to restore: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
