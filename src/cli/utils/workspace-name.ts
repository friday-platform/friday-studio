import { join } from "@std/path";
import { exists } from "@std/fs";
import { parse as parseYaml } from "@std/yaml";

/**
 * Get the current workspace name from workspace.yml without loading full configuration
 * This is a lightweight alternative to ConfigLoader for CLI commands that just need the name
 */
export async function getCurrentWorkspaceName(workspaceDir?: string): Promise<string | null> {
  const targetDir = workspaceDir || Deno.cwd();

  // Check for workspace.yml in current directory
  const workspaceYmlPath = join(targetDir, "workspace.yml");

  if (!(await exists(workspaceYmlPath))) {
    return null;
  }

  try {
    const content = await Deno.readTextFile(workspaceYmlPath);
    const config = parseYaml(content) as any;

    // Extract workspace name from the config
    return config?.workspace?.name || null;
  } catch {
    return null;
  }
}

/**
 * Check if the current directory contains a valid workspace
 */
export async function isValidWorkspace(workspaceDir?: string): Promise<boolean> {
  const name = await getCurrentWorkspaceName(workspaceDir);
  return name !== null;
}
