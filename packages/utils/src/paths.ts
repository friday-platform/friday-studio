import { join } from "@std/path";

/**
 * This module should only be loaded in server code because it relies
 * on the Deno namespace to be available - this will crash in browsers!
 */
// Cache the working directory at startup since it never changes
// This prevents EMFILE errors from concurrent Deno.cwd() calls
// and improves performance by avoiding unnecessary syscalls
const CACHED_CWD = Deno.cwd();

/**
 * Check if Atlas is running as a system service
 */
export function isSystemService(): boolean {
  // Check if running as system service by:
  // 1. Running as root (uid 0)
  // 2. Or ATLAS_SYSTEM_MODE env var is set
  // 3. Or running as 'atlas' user
  if (Deno.build.os === "windows") {
    return false; // Windows doesn't use this pattern
  }

  const uid = Deno.uid();
  if (uid === 0) {
    return true; // Running as root
  }

  if (Deno.env.get("ATLAS_SYSTEM_MODE") === "true") {
    return true; // Explicitly set to system mode
  }

  // Check if running as 'atlas' user
  try {
    // @ts-expect-error - userInfo is available in some Deno versions
    const userInfo = Deno.userInfo?.();
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
  const atlasHome = Deno.env.get("ATLAS_HOME");
  if (atlasHome) {
    return atlasHome;
  }

  // Check if running as system service
  if (isSystemService() && Deno.build.os !== "windows") {
    return "/var/lib/atlas";
  }

  // Check if we're already running from within .atlas directory
  // This handles the case where the compiled atlas binary runs from ~/.atlas/
  const cwd = CACHED_CWD;
  const sep = Deno.build.os === "windows" ? "\\" : "/";
  if (cwd.endsWith(".atlas") || cwd.includes(`.atlas${sep}`)) {
    // We're in .atlas directory, return the parent .atlas directory
    const parts = cwd.split(sep);
    const atlasIndex = parts.lastIndexOf(".atlas");
    if (atlasIndex > 0) {
      return parts.slice(0, atlasIndex + 1).join(sep);
    }
  }

  // User mode: use home directory
  const homeDir = Deno.env.get("HOME") || Deno.env.get("USERPROFILE");
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
 * Get MECMF cache directory (global)
 * Used for caching embeddings models and tokenizers
 */
export function getMECMFCacheDir(): string {
  return join(getAtlasMemoryDir(), ".cache");
}

/**
 * Get workspace files directory for a specific workspace
 * Used for storing generated/transformed files that need to persist
 */
export function getWorkspaceFilesDir(workspaceId: string): string {
  return join(getAtlasHome(), "artifacts", workspaceId);
}
