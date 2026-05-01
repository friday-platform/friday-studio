/**
 * Builds a __meta result object from workspace runtime context.
 *
 * Called by WorkspaceRuntime before dispatching signals to the FSM engine,
 * so every code action sees `context.results['__meta']` with repo_root,
 * workspace_path, workspace_id, and platform_url.
 */

import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

export const WorkspaceMetaSchema = z.object({
  repo_root: z.string(),
  workspace_path: z.string(),
  workspace_id: z.string(),
  platform_url: z.string(),
});

export type WorkspaceMeta = z.infer<typeof WorkspaceMetaSchema>;

/**
 * Walk up the filesystem from `startPath` until a `.git` entry (file or
 * directory) is found. Returns the containing directory, or `null` if the
 * filesystem root is reached without finding `.git`.
 *
 * Handles both regular repos (`.git` is a directory) and git worktrees
 * (`.git` is a file pointing at the shared object store).
 */
export function findRepoRoot(startPath: string): string | null {
  let dir = startPath;
  while (true) {
    const gitEntry = join(dir, ".git");
    try {
      statSync(gitEntry);
      return dir;
    } catch {
      // Not found at this level — walk up.
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export interface BuildWorkspaceMetaInput {
  workspacePath: string;
  workspaceId: string;
  daemonUrl?: string;
}

/**
 * Build the `__meta` result object that gets seeded into the FSM engine
 * before any signal processing.
 *
 * - `repo_root` is derived by walking up from `workspacePath` to find `.git`.
 *   Falls back to `workspacePath` itself if no `.git` ancestor is found.
 * - `workspace_path` is the raw `workspacePath` as-is.
 * - `workspace_id` is passed through.
 * - `platform_url` defaults to `http://localhost:4242` when `daemonUrl` is
 *   not provided.
 */
export function buildWorkspaceMeta(input: BuildWorkspaceMetaInput): WorkspaceMeta {
  const repoRoot = findRepoRoot(input.workspacePath) ?? input.workspacePath;

  return {
    repo_root: repoRoot,
    workspace_path: input.workspacePath,
    workspace_id: input.workspaceId,
    platform_url: input.daemonUrl ?? "http://localhost:4242",
  };
}
