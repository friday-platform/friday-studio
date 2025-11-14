import { client, parseResult } from "@atlas/client/v2";
import { type WorkspaceConfig, WorkspaceConfigSchema } from "@atlas/config";
import { parse } from "@std/yaml";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { goto } from "$app/navigation";

/**
 * Parse workspace name from workspace.yml file
 */
async function parseWorkspaceConfig(filePath: string): Promise<WorkspaceConfig | null> {
  try {
    const content = await readTextFile(filePath);
    const parsed = WorkspaceConfigSchema.parse(parse(content));
    return parsed;
  } catch (error) {
    console.error("Failed to parse workspace.yml:", error);
    return null;
  }
}

/**
 * Handle workspace.yml drop - focuses window and parses workspace info
 */
export async function handleWorkspaceFileDrop(
  filePath: string,
): Promise<{ path: string; config: WorkspaceConfig } | null> {
  const fileName = filePath.split("/").pop() || "";

  if (fileName !== "workspace.yml") {
    return null;
  }

  // Focus the window when workspace is dropped
  try {
    await getCurrentWindow().setFocus();
  } catch (error) {
    console.error("Failed to focus window:", error);
  }

  // Parse workspace name from the YAML file
  const config = await parseWorkspaceConfig(filePath);

  if (!config) {
    return null;
  }

  return { path: filePath, config };
}

/**
 * Add workspace to daemon and navigate to it
 */
export async function addWorkspace(
  config: WorkspaceConfig,
  options: { refreshWorkspaces: () => void; getSpaceRoute: (id: string) => string },
): Promise<void> {
  const res = await parseResult(
    client.workspace.create.$post({
      json: { config, workspaceName: config.workspace.name, ephemeral: false },
    }),
  );

  if (!res.ok) {
    console.error("Failed to add workspace:", res.error);
    throw new Error(typeof res.error === "string" ? res.error : "Failed to add workspace");
  }

  const workspaceId = res.data.workspace.id;

  // Refresh the workspaces list in the sidebar
  options.refreshWorkspaces();

  // Navigate to the new workspace
  await goto(options.getSpaceRoute(workspaceId));
}
