import { join } from "@std/path";

/**
 * Get the Atlas home directory
 * Defaults to ~/.atlas
 */
export function getAtlasHome(): string {
  const atlasHome = Deno.env.get("ATLAS_HOME");
  if (atlasHome) {
    return atlasHome;
  }

  const homeDir = Deno.env.get("HOME") || Deno.env.get("USERPROFILE");
  if (!homeDir) {
    throw new Error("Unable to determine home directory");
  }

  return join(homeDir, ".atlas");
}

/**
 * Get the Atlas logs directory
 */
export function getAtlasLogsDir(): string {
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
