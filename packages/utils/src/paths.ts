import os from "node:os";
import { join } from "node:path";
import process from "node:process";

/**
 * This module should only be loaded in server code because it relies
 * on the Node.js process namespace to be available - this will crash in browsers!
 */
// Cache the working directory at startup since it never changes
// This prevents EMFILE errors from concurrent process.cwd() calls
// and improves performance by avoiding unnecessary syscalls
const CACHED_CWD = process.cwd();

/**
 * Check if Atlas is running as a system service
 */
export function isSystemService(): boolean {
  // Check if running as system service by:
  // 1. Running as root (uid 0)
  // 2. Or ATLAS_SYSTEM_MODE env var is set
  // 3. Or running as 'atlas' user
  if (process.platform === "win32") {
    return false; // Windows doesn't use this pattern
  }

  const uid = process.getuid?.();
  if (uid === 0) {
    return true; // Running as root
  }

  if (process.env.ATLAS_SYSTEM_MODE === "true") {
    return true; // Explicitly set to system mode
  }

  // Check if running as 'atlas' user
  try {
    const userInfo = os.userInfo();
    if (userInfo?.username === "atlas") {
      return true;
    }
  } catch {
    // Ignore errors
  }

  return false;
}

/**
 * Get the Atlas home directory
 * - System mode: /var/lib/atlas
 * - User mode: ~/.atlas
 */
export function getAtlasHome(): string {
  const atlasHome = process.env.FRIDAY_HOME;
  if (atlasHome) {
    return atlasHome;
  }

  // Check if running as system service
  if (isSystemService() && process.platform !== "win32") {
    return "/var/lib/atlas";
  }

  // Check if we're already running from within .atlas directory
  // This handles the case where the compiled atlas binary runs from ~/.atlas/
  const cwd = CACHED_CWD;
  const sep = process.platform === "win32" ? "\\" : "/";
  if (cwd.endsWith(".atlas") || cwd.includes(`.atlas${sep}`)) {
    // We're in .atlas directory, return the parent .atlas directory
    const parts = cwd.split(sep);
    const atlasIndex = parts.lastIndexOf(".atlas");
    if (atlasIndex > 0) {
      return parts.slice(0, atlasIndex + 1).join(sep);
    }
  }

  // User mode: use home directory
  const homeDir = process.env.HOME || process.env.USERPROFILE;
  if (!homeDir) {
    throw new Error("Unable to determine home directory");
  }

  return join(homeDir, ".atlas");
}

/**
 * Get the Atlas memory directory (global)
 */
export function getAtlasMemoryDir(): string {
  return join(getAtlasHome(), "memory");
}

/**
 * Get workspace files directory for a specific workspace
 * Used for storing generated/transformed files that need to persist
 */
export function getWorkspaceFilesDir(workspaceId: string): string {
  return join(getAtlasHome(), "artifacts", workspaceId);
}
