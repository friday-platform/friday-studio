import { getAtlasHome, isSystemService } from "@atlas/utils";
import { join } from "@std/path";

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
