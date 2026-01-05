import { client, parseResult } from "@atlas/client/v2";
import { type WorkspaceConfig, WorkspaceConfigSchema } from "@atlas/config";
import { parse } from "@std/yaml";
import { ZodError } from "zod";
import { goto } from "$app/navigation";
import { toast } from "$lib/components/notification/notification.svelte";

/**
 * Handle .yml/.yaml file selection - parses workspace config from File object
 */
export async function handleWorkspaceFile(file: File): Promise<{ config: WorkspaceConfig } | null> {
  // Silently ignore non-yaml files
  if (!file.name.endsWith(".yml") && !file.name.endsWith(".yaml")) {
    return null;
  }

  try {
    const content = await file.text();
    const config = WorkspaceConfigSchema.parse(parse(content));
    return { config };
  } catch (error) {
    if (error instanceof ZodError) {
      console.warn("Workspace config validation failed:", error.issues);
    }
    toast({
      title: "Couldn't add Space",
      description: "This isn't a valid workspace.yml file.",
      error: true,
    });
    return null;
  }
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
