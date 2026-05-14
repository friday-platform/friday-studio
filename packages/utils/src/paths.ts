import os from "node:os";
import { join } from "node:path";
import process from "node:process";

/**
 * This module should only be loaded in server code because it relies
 * on the Node.js process namespace to be available - this will crash in browsers!
 */

/**
 * Check if Friday is running as a system service
 */
export function isSystemService(): boolean {
  // Check if running as system service by:
  // 1. Running as root (uid 0)
  // 2. Or FRIDAY_SYSTEM_MODE env var is set
  // 3. Or running as 'atlas' user
  if (process.platform === "win32") {
    return false; // Windows doesn't use this pattern
  }

  const uid = process.getuid?.();
  if (uid === 0) {
    return true; // Running as root
  }

  if (process.env.FRIDAY_SYSTEM_MODE === "true") {
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
 * Get the Friday home directory.
 *
 * - `FRIDAY_HOME` env wins when set.
 * - System mode: `/var/lib/atlas`.
 * - User mode: `~/.friday/local` (matches the launcher's
 *   `friendlyHome()` default and the installer's
 *   `friday_home_dir()` default). The dev `deno task atlas` task in
 *   `deno.json` pins `FRIDAY_HOME=$HOME/.atlas` explicitly to keep
 *   dev state at the legacy location with the inference made legible.
 */
export function getFridayHome(): string {
  const fridayHome = process.env.FRIDAY_HOME;
  if (fridayHome) {
    return fridayHome;
  }

  // Check if running as system service
  if (isSystemService() && process.platform !== "win32") {
    return "/var/lib/atlas";
  }

  // User mode: default under the user's home directory.
  const homeDir = process.env.HOME || process.env.USERPROFILE;
  if (!homeDir) {
    throw new Error("Unable to determine home directory");
  }

  return join(homeDir, ".friday", "local");
}

/**
 * Get the Atlas memory directory (global)
 */
export function getAtlasMemoryDir(): string {
  return join(getFridayHome(), "memory");
}

/**
 * Get workspace files directory for a specific workspace
 * Used for storing generated/transformed files that need to persist
 */
export function getWorkspaceFilesDir(workspaceId: string): string {
  return join(getFridayHome(), "artifacts", workspaceId);
}

/**
 * Per-workspace, per-chat scratch uploads root —
 * `{FRIDAY_HOME}/scratch/uploads/{workspaceId}/{chatId}/`. The single
 * canonical helper for this path; the upload route writes here, the adapter
 * validates paths against it, the `read_attachment` tool resolves against it,
 * and `ChatStorage.deleteChat` should GC it.
 *
 * Caller invariant: `workspaceId` and `chatId` must already be validated via
 * `isInvalidChatId` from `@atlas/core/artifacts/file-upload`. This function
 * does NOT sanitize inputs — validation lives at the route / adapter boundary
 * where we can return a meaningful error to the client.
 */
export function chatUploadsRoot(workspaceId: string, chatId: string): string {
  return join(getFridayHome(), "scratch", "uploads", workspaceId, chatId);
}
