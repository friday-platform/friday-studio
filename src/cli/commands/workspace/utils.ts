import { exists } from "@std/fs";
import * as yaml from "@std/yaml";
import { getWorkspaceRegistry } from "../../../core/workspace-registry.ts";

// Shared component for workspace status
export async function getWorkspaceStatus(workspaceId?: string) {
  let workspacePath = Deno.cwd();

  if (workspaceId) {
    // Find workspace by ID in the registry
    const registry = getWorkspaceRegistry();
    const targetWorkspace = (await registry.findById(workspaceId)) ||
      (await registry.findByName(workspaceId));

    if (!targetWorkspace) {
      throw new Error(
        `Workspace '${workspaceId}' not found in registry. Use 'atlas workspace list' to see registered workspaces.`,
      );
    }

    workspacePath = targetWorkspace.path;
  } else {
    // Check current directory for workspace.yml
    if (!(await exists("workspace.yml"))) {
      throw new Error(
        'No workspace.yml found. Run "atlas workspace init" first or specify a workspace-id.',
      );
    }
  }

  // Load configuration from the determined workspace path
  const originalCwd = Deno.cwd();
  try {
    Deno.chdir(workspacePath);

    const { ConfigLoader } = await import("../../../core/config-loader.ts");
    const configLoader = new ConfigLoader();
    const mergedConfig = await configLoader.load();
    const config = mergedConfig.workspace;
    const metadata = (await exists(".atlas/workspace.json"))
      ? JSON.parse(await Deno.readTextFile(".atlas/workspace.json"))
      : {};

    // Check if server is running
    let serverRunning = false;
    try {
      const response = await fetch(
        `http://localhost:${mergedConfig.atlas.runtime?.server?.port || 8080}/health`,
      );
      if (response.ok) {
        const healthData = await response.json();
        // Verify that the running server is serving the correct workspace
        const expectedWorkspaceId = metadata.id || config.workspace.id;
        serverRunning = healthData.workspace === expectedWorkspaceId;
      }
    } catch (error) {
      throw new Error(`Server health check failed: ${error}`);
    }

    return {
      workspace: {
        ...config.workspace,
        id: metadata.id || config.workspace.id,
        createdAt: metadata.createdAt,
        path: workspaceId ? workspacePath : undefined,
      },
      agents: Object.keys(config.agents || {}),
      signals: Object.keys(config.signals || {}),
      serverRunning,
      port: mergedConfig.atlas.runtime?.server?.port || 8080,
    };
  } finally {
    Deno.chdir(originalCwd);
  }
}

// Common props interface
export interface WorkspaceCommandProps {
  args: string[];
  flags: Record<string, unknown>;
}
