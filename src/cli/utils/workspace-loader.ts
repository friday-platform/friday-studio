import { parse } from "@std/yaml";
import { join } from "@std/path";
import { getWorkspaceDiscoveryDirs } from "../../utils/paths.ts";
import { exists } from "@std/fs";

export interface WorkspaceConfig {
  workspace: {
    id: string;
    name: string;
    description: string;
  };
  signals?: Record<string, unknown>;
  agents?: Record<string, unknown>;
  jobs?: Record<string, unknown>;
}

export async function loadWorkspaceConfig(workspaceSlug: string): Promise<WorkspaceConfig | null> {
  try {
    // Try to find workspace in configured discovery directories
    const discoveryDirs = getWorkspaceDiscoveryDirs();

    for (const dir of discoveryDirs) {
      const workspacePath = join(dir, workspaceSlug, "workspace.yml");
      if (await exists(workspacePath)) {
        const workspaceContent = await Deno.readTextFile(workspacePath);
        const config = parse(workspaceContent) as WorkspaceConfig;
        return config;
      }
    }

    // Fallback to original behavior if not found in discovery dirs
    const gitRoot = getGitRoot();
    const workspacePath = join(gitRoot, "examples", "workspaces", workspaceSlug, "workspace.yml");

    const workspaceContent = await Deno.readTextFile(workspacePath);
    const config = parse(workspaceContent) as WorkspaceConfig;

    return config;
  } catch (error) {
    console.error(`Failed to load workspace config for ${workspaceSlug}:`, error);
    return null;
  }
}

function getGitRoot(): string {
  try {
    const gitRoot = new Deno.Command("git", {
      args: ["rev-parse", "--show-toplevel"],
    }).outputSync();

    if (!gitRoot.success) {
      throw new Error("Not in a git repository");
    }

    return new TextDecoder().decode(gitRoot.stdout).trim();
  } catch {
    throw new Error("Could not find git repository root");
  }
}
