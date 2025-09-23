import { getAtlasHome, isSystemService } from "@atlas/utils/paths.server";
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
function getAtlasMemoryDir(): string {
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
 * Get workspace-specific vector search directory
 */
export function getWorkspaceVectorDir(workspaceId: string): string {
  return join(getWorkspaceMemoryDir(workspaceId), "vectors");
}

/**
 * Get MECMF cache directory (global)
 * Used for caching embeddings models and tokenizers
 */
export function getMECMFCacheDir(): string {
  return join(getAtlasMemoryDir(), ".cache");
}
