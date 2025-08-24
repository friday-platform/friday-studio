import { ConfigLoader, type WorkspaceConfig } from "@atlas/config";
import { FilesystemConfigAdapter } from "@atlas/storage";
import { getWorkspaceManager } from "@atlas/workspace"; // TODO: Use @atlas/client instead
import { exists } from "@std/fs";

// Helper function to resolve workspace and load config
export async function resolveWorkspaceAndConfig(
  workspaceId?: string,
): Promise<{ workspace: { path: string; id: string; name: string }; config: WorkspaceConfig }> {
  const registry = await getWorkspaceManager();
  await registry.initialize();

  let workspacePath = Deno.cwd();
  let workspaceInfo: { path: string; id: string; name: string };

  if (workspaceId) {
    // Find workspace by ID or name in the registry
    const targetWorkspace =
      (await registry.find({ id: workspaceId })) || (await registry.find({ name: workspaceId }));

    if (!targetWorkspace) {
      throw new Error(
        `Workspace '${workspaceId}' not found in registry. Use 'atlas workspace list' to see registered workspaces.`,
      );
    }

    workspacePath = targetWorkspace.path;
    workspaceInfo = {
      path: targetWorkspace.path,
      id: targetWorkspace.id,
      name: targetWorkspace.name,
    };
  } else {
    // Check current directory for workspace.yml
    if (!(await exists("workspace.yml"))) {
      throw new Error(
        "No workspace specified and not in a workspace directory. " +
          "Use --workspace flag or run from a workspace directory.",
      );
    }

    // Try to find in registry or register
    const currentWorkspace = await registry.registerWorkspace(Deno.cwd());

    workspaceInfo = {
      path: currentWorkspace.path,
      id: currentWorkspace.id,
      name: currentWorkspace.name,
    };
  }

  // Load configuration from the determined workspace path
  const originalCwd = Deno.cwd();
  try {
    Deno.chdir(workspacePath);
    const adapter = new FilesystemConfigAdapter(workspacePath);
    const configLoader = new ConfigLoader(adapter, workspacePath);
    const mergedConfig = await configLoader.load();
    return { workspace: workspaceInfo, config: mergedConfig.workspace };
  } finally {
    Deno.chdir(originalCwd);
  }
}

// Alternative resolver that doesn't change directories (for interactive use)
export async function resolveWorkspaceAndConfigNoCwd(
  workspaceId: string,
): Promise<{ workspace: { path: string; id: string; name: string }; config: WorkspaceConfig }> {
  const registry = await getWorkspaceManager();
  await registry.initialize();
  const targetWorkspace = await registry.find({ id: workspaceId });

  if (!targetWorkspace) {
    throw new Error(`Workspace ${workspaceId} not found`);
  }

  // ConfigLoader with absolute path - no directory change needed!
  const adapter = new FilesystemConfigAdapter(targetWorkspace.path);
  const configLoader = new ConfigLoader(adapter, targetWorkspace.path);
  const mergedConfig = await configLoader.load();

  const workspaceInfo = {
    path: targetWorkspace.path,
    id: targetWorkspace.id,
    name: targetWorkspace.name,
  };

  return { workspace: workspaceInfo, config: mergedConfig.workspace };
}

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

// Load workspace config without directory change (for interactive)
export async function loadWorkspaceConfigNoCwd(workspacePath: string): Promise<WorkspaceConfig> {
  const adapter = new FilesystemConfigAdapter(workspacePath);
  const configLoader = new ConfigLoader(adapter, workspacePath);
  const mergedConfig = await configLoader.load();
  return mergedConfig.workspace;
}
