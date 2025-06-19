import { parse } from "@std/yaml";
import { join } from "@std/path";

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
    // Try to find workspace in examples/workspaces directory
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
  } catch (_error) {
    throw new Error("Could not find git repository root");
  }
}
