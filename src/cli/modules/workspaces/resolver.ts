import { ConfigLoader, type WorkspaceConfig } from "@atlas/config";
import { FilesystemConfigAdapter } from "@atlas/storage";
import { getWorkspaceManager } from "@atlas/workspace"; // TODO: Use @atlas/client instead
import { exists } from "@std/fs";

// Enhanced workspace resolution (cleaner separation)
export async function resolveWorkspaceOnly(
  workspaceId?: string,
): Promise<{ path: string; id: string; name: string }> {
  const registry = await getWorkspaceManager();
  await registry.initialize();

  if (workspaceId) {
    // Find by ID or name in registry
    const workspace =
      (await registry.find({ id: workspaceId })) || (await registry.find({ name: workspaceId }));

    if (!workspace) {
      throw new Error(
        `Workspace '${workspaceId}' not found. ` +
          `Run 'atlas workspace list' to see available workspaces.`,
      );
    }

    return { path: workspace.path, id: workspace.id, name: workspace.name };
  } else {
    // Try current directory
    const currentWorkspace = await registry.find({ path: Deno.cwd() });

    if (currentWorkspace) {
      return { path: currentWorkspace.path, id: currentWorkspace.id, name: currentWorkspace.name };
    }

    // Fallback to checking for workspace.yml in current directory
    if (await exists("workspace.yml")) {
      // Register this workspace if not already registered
      const workspace = await registry.registerWorkspace(Deno.cwd());
      return { path: workspace.path, id: workspace.id, name: workspace.name };
    }

    throw new Error(
      "No workspace specified and not in a workspace directory. " +
        "Use --workspace flag or run from a workspace directory.",
    );
  }
}

// Load workspace config with directory change (for CLI)
export async function loadWorkspaceConfig(workspacePath: string): Promise<WorkspaceConfig> {
  const originalCwd = Deno.cwd();
  try {
    Deno.chdir(workspacePath);
    const adapter = new FilesystemConfigAdapter(workspacePath);
    const configLoader = new ConfigLoader(adapter, workspacePath);
    const mergedConfig = await configLoader.load();
    return mergedConfig.workspace;
  } finally {
    Deno.chdir(originalCwd);
  }
}
