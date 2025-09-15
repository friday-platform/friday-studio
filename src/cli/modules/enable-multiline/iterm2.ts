/**
 * iTerm2 setup implementation
 */

import { join } from "@std/path";
import type { SetupResult } from "./types.ts";
import { execCommand, fileExists, getHomeDir } from "./utils.ts";

/**
 * Get the iTerm2 preferences plist path
 */
function getITerm2PlistPath(): string {
  return join(getHomeDir(), "Library", "Preferences", "com.googlecode.iterm2.plist");
}

/**
 * Create a backup of iTerm2 preferences
 */
async function createITerm2Backup(): Promise<string | null> {
  const plistPath = getITerm2PlistPath();
  const backupPath = `${plistPath}.bak-${Date.now()}`;

  try {
    // Export current preferences
    await execCommand("defaults", ["export", "com.googlecode.iterm2", plistPath]);

    // Create backup copy
    if (await fileExists(plistPath)) {
      await Deno.copyFile(plistPath, backupPath);
      return backupPath;
    }
  } catch (error) {
    console.error("Failed to create iTerm2 backup:", error);
  }

  return null;
}

/**
 * Get the XML plist dictionary for Shift+Enter keybinding
 */
function getKeybindingPlist(): string {
  return `<dict>
    <key>Text</key>
    <string>\\n</string>
    <key>Action</key>
    <integer>12</integer>
    <key>Version</key>
    <integer>1</integer>
    <key>Keycode</key>
    <integer>13</integer>
    <key>Modifiers</key>
    <integer>131072</integer>
  </dict>`;
}

/**
 * Check if Shift+Enter keybinding already exists
 */
async function hasShiftEnterKeybinding(): Promise<boolean> {
  try {
    const { stdout, success } = await execCommand("defaults", [
      "read",
      "com.googlecode.iterm2",
      "GlobalKeyMap",
    ]);

    if (success && stdout) {
      // Check if the key combination already exists
      // 0xd-0x20000-0x24 is the key code for Shift+Enter
      return stdout.includes("0xd-0x20000-0x24");
    }
  } catch {
    // GlobalKeyMap might not exist yet
  }

  return false;
}

/**
 * Setup iTerm2 for multi-line input
 */
export async function setupITerm2(): Promise<SetupResult> {
  try {
    // Check if keybinding already exists
    if (await hasShiftEnterKeybinding()) {
      return { success: true };
    }

    // Create backup
    const backupPath = await createITerm2Backup();
    if (!backupPath) {
      return { success: false, error: "Failed to create backup of iTerm2 preferences" };
    }

    // Add Shift+Enter keybinding to GlobalKeyMap
    // 0xd-0x20000-0x24 is the key code for Shift+Enter
    const { success, stderr } = await execCommand("defaults", [
      "write",
      "com.googlecode.iterm2",
      "GlobalKeyMap",
      "-dict-add",
      "0xd-0x20000-0x24",
      getKeybindingPlist(),
    ]);

    if (!success) {
      return {
        success: false,
        error: stderr || "Failed to install iTerm2 Shift+Enter keybinding",
        backupPath,
      };
    }

    // Export updated preferences back to plist file
    await execCommand("defaults", ["export", "com.googlecode.iterm2", getITerm2PlistPath()]);

    return { success: true, backupPath };
  } catch (error) {
    console.error("iTerm2 setup failed:", error);

    return {
      success: false,
      error: `Failed to configure iTerm2: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/**
 * Restore iTerm2 from backup
 */
async function restoreITerm2(backupPath: string): Promise<SetupResult> {
  if (!(await fileExists(backupPath))) {
    return { success: false, error: "Backup file no longer exists" };
  }

  try {
    const { success } = await execCommand("defaults", [
      "import",
      "com.googlecode.iterm2",
      backupPath,
    ]);

    if (!success) {
      return { success: false, error: "Failed to restore iTerm2 settings" };
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: `Failed to restore: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
