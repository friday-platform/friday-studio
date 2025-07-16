import { join } from "@std/path";

/**
 * Check if Atlas is running as a system service
 */
function isSystemService(): boolean {
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
    const userInfo = Deno.userInfo();
    if (userInfo.username === "atlas") {
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

  // User mode: use home directory
  const homeDir = Deno.env.get("HOME") || Deno.env.get("USERPROFILE");
  if (!homeDir) {
    throw new Error("Unable to determine home directory");
  }

  return join(homeDir, ".atlas");
}

/**
 * Get the Atlas logs directory
 * - System mode: /var/log/atlas
 * - User mode: ~/.atlas/logs
 */
export function getAtlasLogsDir(): string {
  // Allow override
  const logsDir = Deno.env.get("ATLAS_LOGS_DIR");
  if (logsDir) {
    return logsDir;
  }

  // System mode uses /var/log/atlas
  if (isSystemService() && Deno.build.os !== "windows") {
    return "/var/log/atlas";
  }

  // User mode uses ~/.atlas/logs
  return join(getAtlasHome(), "logs");
}

/**
 * Get the Atlas workspaces logs directory
 */
export function getWorkspaceLogsDir(): string {
  return join(getAtlasLogsDir(), "workspaces");
}

/**
 * Get the Atlas registry file path
 */
export function getRegistryPath(): string {
  return join(getAtlasHome(), "registry.json");
}

/**
 * Get the Atlas config directory
 */
export function getAtlasConfigDir(): string {
  return join(getAtlasHome(), "config");
}

/**
 * Get the Atlas cache directory
 */
export function getAtlasCacheDir(): string {
  return join(getAtlasHome(), "cache");
}
