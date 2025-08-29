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
    // @ts-ignore - userInfo is available in some Deno versions
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
  const cwd = Deno.cwd();
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

/**
 * Sanitize workspace name for use as folder name
 * Converts workspace IDs to safe filesystem folder names
 */
function sanitizeWorkspaceName(workspaceId: string): string {
  return workspaceId
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-") // Replace invalid chars with dash
    .replace(/-+/g, "-") // Collapse multiple dashes
    .replace(/^-|-$/g, ""); // Remove leading/trailing dashes
}

/**
 * Get the Atlas memory directory (global)
 */
export function getAtlasMemoryDir(): string {
  return join(getAtlasHome(), "memory");
}

/**
 * Get workspace-specific memory directory
 * Each workspace gets its own isolated memory folder
 */
export function getWorkspaceMemoryDir(workspaceId: string): string {
  const sanitizedName = sanitizeWorkspaceName(workspaceId);
  return join(getAtlasMemoryDir(), sanitizedName);
}

/**
 * Get workspace-specific memory file path for a given memory type
 */
export function getWorkspaceMemoryFilePath(workspaceId: string, memoryType: string): string {
  return join(getWorkspaceMemoryDir(workspaceId), `${memoryType}.json`);
}

/**
 * Get workspace-specific vector search directory
 */
export function getWorkspaceVectorDir(workspaceId: string): string {
  return join(getWorkspaceMemoryDir(workspaceId), "vectors");
}

/**
 * Get workspace-specific knowledge graph directory
 */
export function getWorkspaceKnowledgeGraphDir(workspaceId: string): string {
  return join(getWorkspaceMemoryDir(workspaceId), "knowledge-graph");
}

/**
 * Get MECMF cache directory (global)
 * Used for caching embeddings models and tokenizers
 */
export function getMECMFCacheDir(): string {
  return join(getAtlasMemoryDir(), ".cache");
}

/**
 * Get workspace-specific MECMF cache directory
 */
export function getWorkspaceMECMFCacheDir(workspaceId: string): string {
  return join(getWorkspaceMemoryDir(workspaceId), ".cache");
}

/**
 * Get directories to scan for workspace discovery
 * Can be overridden with ATLAS_WORKSPACES_DIR environment variable
 *
 * @returns Array of directory paths to scan for workspaces
 */
export function getWorkspaceDiscoveryDirs(): string[] {
  const envDirs = Deno.env.get("ATLAS_WORKSPACES_DIR");

  if (envDirs) {
    // Support multiple paths separated by platform-specific delimiter
    const delimiter = Deno.build.os === "windows" ? ";" : ":";
    const dirs = envDirs
      .split(delimiter)
      .map((dir) => dir.trim())
      .filter((dir) => dir.length > 0);

    if (dirs.length > 0) {
      return dirs;
    }
  }

  // Fall back to default paths if env var not set or empty
  const rootPath = Deno.cwd();
  return [join(rootPath, "examples", "workspaces"), join(rootPath, "workspaces"), rootPath];
}
