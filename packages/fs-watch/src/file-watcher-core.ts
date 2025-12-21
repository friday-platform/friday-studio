import { env } from "node:process";
import { logger } from "@atlas/logger";
import { isAbsolute, join, normalize, relative, resolve } from "@std/path";

export type WatchEventKind = "create" | "modify" | "remove" | "any";

export type NormalizedWatchEvent = "added" | "modified" | "removed";

export interface ResolvePathOptions {
  basePath?: string; // workspace root or cwd
}

export function expandHomePath(inputPath: string): string {
  if (inputPath.startsWith("~/")) {
    const home = env.HOME || env.USERPROFILE;
    if (home) return join(home, inputPath.slice(2));
  }
  if (inputPath.startsWith("$HOME/")) {
    const home = env.HOME || env.USERPROFILE;
    if (home) return join(home, inputPath.slice("$HOME/".length));
  }
  return inputPath;
}

export function resolveToAbsolutePath(
  pathToResolve: string,
  options: ResolvePathOptions = {},
): string {
  const base = options.basePath || Deno.cwd();
  const configuredPath = expandHomePath(pathToResolve);
  const absolutePath = isAbsolute(configuredPath)
    ? normalize(configuredPath)
    : normalize(resolve(base, configuredPath));
  return absolutePath;
}

/**
 * Maps Deno filesystem events to normalized watch events for consistent processing.
 *
 * Event mappings:
 * - "create" → "added": New file/directory created
 * - "modify" → "modified": File content or metadata changed
 * - "remove" → "removed": File/directory deleted
 * - "rename" → "modified": File/directory renamed or moved within same volume
 *
 * Note on "rename" events:
 * On macOS/Unix systems, moving a file within the same volume (e.g., between folders
 * on the same disk) is implemented as a rename() system call, not a copy+delete.
 * This is because the file's data stays in the same physical location - only the
 * path pointer (inode) changes. FSEvents reports this as a "rename" event whether
 * you're changing the filename or moving between directories. We map this to
 * "modified" since it represents a change in the file's identity/location.
 */
export function mapFsEventKind(kind: Deno.FsEvent["kind"]): NormalizedWatchEvent | null {
  if (kind === "create") return "added";
  if (kind === "modify") return "modified";
  if (kind === "remove") return "removed";
  if (kind === "rename") return "modified";

  logger.warn("unmapped fs event kind, ignoring", { kind });
  return null;
}

export function computeRelativeToRoot(pathAbs: string, workspaceRoot?: string): string | undefined {
  if (!workspaceRoot) return undefined;
  const rootNorm = normalize(workspaceRoot);
  const rel = relative(rootNorm, pathAbs);
  if (rel.startsWith("..")) return undefined;
  return rel || ".";
}

export async function isDirectoryPath(pathAbs: string): Promise<boolean> {
  try {
    const stats = await Deno.stat(pathAbs);
    return stats.isDirectory;
  } catch {
    return false;
  }
}
