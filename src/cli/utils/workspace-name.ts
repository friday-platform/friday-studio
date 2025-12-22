import { readFile } from "node:fs/promises";
import { exists } from "@std/fs";
import { join } from "@std/path";
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
    const content = await readFile(workspaceYmlPath, "utf-8");
    // @TODO: check this with Zod
    const config = parseYaml(content);

    // Extract workspace name from the config
    // @ts-expect-error config is unknown, but we're guarding it
    return config?.workspace?.name || null;
  } catch {
    return null;
  }
}
