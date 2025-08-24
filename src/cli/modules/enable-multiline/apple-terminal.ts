/**
 * Apple Terminal setup implementation
 */

import { join } from "@std/path";
import type { SetupResult } from "./types.ts";
import { execCommand, fileExists, getHomeDir } from "./utils.ts";

/**
 * Get the Terminal.app preferences plist path
 */
function getTerminalPlistPath(): string {
  return join(getHomeDir(), "Library", "Preferences", "com.apple.Terminal.plist");
}

/**
 * Create a backup of Terminal.app preferences
 */
async function createTerminalBackup(): Promise<string | null> {
  const plistPath = getTerminalPlistPath();
  const backupPath = `${plistPath}.bak-${Date.now()}`;

  try {
    // Export current preferences to backup
    const { success } = await execCommand("defaults", ["export", "com.apple.Terminal", backupPath]);

    if (success && (await fileExists(backupPath))) {
      return backupPath;
    }
  } catch (error) {
    console.error("Failed to create Terminal.app backup:", error);
  }

  return null;
}

/**
 * Enable "Use Option as Meta Key" for a specific Terminal profile
 */
async function enableOptionAsMetaKey(profileName: string): Promise<boolean> {
  const plistPath = getTerminalPlistPath();

  // Try to add the setting first
  const { success: addSuccess } = await execCommand("/usr/libexec/PlistBuddy", [
    "-c",
    `Add :'Window Settings':'${profileName}':useOptionAsMetaKey bool true`,
    plistPath,
  ]);

  if (addSuccess) {
    return true;
  }

  // If add failed (likely because it already exists), try to set it
  const { success: setSuccess } = await execCommand("/usr/libexec/PlistBuddy", [
    "-c",
    `Set :'Window Settings':'${profileName}':useOptionAsMetaKey true`,
    plistPath,
  ]);

  return setSuccess;
}

/**
 * Get the default Terminal profile name
 */
async function getDefaultProfile(): Promise<string | null> {
  const { stdout, success } = await execCommand("defaults", [
    "read",
    "com.apple.Terminal",
    "Default Window Settings",
  ]);

  if (success && stdout.trim()) {
    return stdout.trim();
  }

  return null;
}

/**
 * Get the startup Terminal profile name
 */
async function getStartupProfile(): Promise<string | null> {
  const { stdout, success } = await execCommand("defaults", [
    "read",
    "com.apple.Terminal",
    "Startup Window Settings",
  ]);

  if (success && stdout.trim()) {
    return stdout.trim();
  }

  return null;
}

/**
 * Refresh macOS preferences daemon
 */
async function refreshPreferences(): Promise<void> {
  await execCommand("killall", ["cfprefsd"]);
}

/**
 * Setup Apple Terminal for multi-line input
 */
export async function setupAppleTerminal(): Promise<SetupResult> {
  try {
    // Create backup
    const backupPath = await createTerminalBackup();
    if (!backupPath) {
      return { success: false, error: "Failed to create backup of Terminal.app preferences" };
    }

    // Get default and startup profiles
    const defaultProfile = await getDefaultProfile();
    const startupProfile = await getStartupProfile();

    if (!defaultProfile) {
      return { success: false, error: "Failed to read Terminal.app default profile", backupPath };
    }

    let modified = false;

    // Enable Option as Meta key for default profile
    const defaultSuccess = await enableOptionAsMetaKey(defaultProfile);
    if (defaultSuccess) {
      modified = true;
    }

    // If startup profile is different, configure it too
    if (startupProfile && startupProfile !== defaultProfile) {
      const startupSuccess = await enableOptionAsMetaKey(startupProfile);
      if (startupSuccess) {
        modified = true;
      }
    }

    if (!modified) {
      return {
        success: false,
        error: "Failed to enable Option as Meta key for any Terminal.app profile",
        backupPath,
      };
    }

    // Refresh preferences daemon
    await refreshPreferences();

    return { success: true, backupPath };
  } catch (error) {
    console.error("Apple Terminal setup failed:", error);

    return {
      success: false,
      error: `Failed to configure Apple Terminal: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/**
 * Restore Apple Terminal from backup
 */
export async function restoreAppleTerminal(backupPath: string): Promise<SetupResult> {
  if (!(await fileExists(backupPath))) {
    return { success: false, error: "Backup file no longer exists" };
  }

  try {
    const { success } = await execCommand("defaults", ["import", "com.apple.Terminal", backupPath]);

    if (!success) {
      return { success: false, error: "Failed to restore Terminal.app settings" };
    }

    // Refresh preferences
    await refreshPreferences();

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: `Failed to restore: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
