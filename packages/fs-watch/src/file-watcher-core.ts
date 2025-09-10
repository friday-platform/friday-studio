import { isAbsolute, join, normalize, relative, resolve } from "@std/path";

export type WatchEventKind = "create" | "modify" | "remove" | "any";

export type NormalizedWatchEvent = "added" | "modified" | "removed";

export interface ResolvePathOptions {
  basePath?: string; // workspace root or cwd
}

export function expandHomePath(inputPath: string): string {
  if (inputPath.startsWith("~/")) {
    const home = Deno.env.get("HOME") || Deno.env.get("USERPROFILE");
    if (home) return join(home, inputPath.slice(2));
  }
  if (inputPath.startsWith("$HOME/")) {
    const home = Deno.env.get("HOME") || Deno.env.get("USERPROFILE");
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

export function mapFsEventKind(kind: Deno.FsEvent["kind"]): NormalizedWatchEvent | null {
  if (kind === "create") return "added";
  if (kind === "modify") return "modified";
  if (kind === "remove") return "removed";
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
