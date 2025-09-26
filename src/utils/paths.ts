import { getAtlasHome } from "@atlas/utils/paths.server";
import { join } from "@std/path";

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
