import { client, DetailedError, parseResult } from "@atlas/client/v2";
import { WorkspaceConfigSchema, type WorkspaceConfig } from "@atlas/config";
import { parse } from "@std/yaml";
import { goto } from "$app/navigation";
import { toast } from "$lib/components/notification/notification.svelte";
import { ZodError } from "zod";

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
    if (isMissingProvidersError(res.error)) {
      const providers = res.error.detail.data.providers;
      const names = providers.map(formatProviderName).join(", ");
      toast({
        title: "Unsupported integrations",
        description: `This Space requires ${names}, which ${providers.length === 1 ? "is" : "are"} not supported.`,
        error: true,
      });
      throw new Error("Unsupported providers");
    }

    toast({
      title: "Couldn't add Space",
      description:
        typeof res.error === "string" ? res.error : "Something went wrong. Please try again.",
      error: true,
    });
    throw new Error(typeof res.error === "string" ? res.error : "Failed to add workspace");
  }

  const workspaceId = res.data.workspace.id;

  // Refresh the workspaces list in the sidebar
  options.refreshWorkspaces();

  // Navigate to the new workspace
  await goto(options.getSpaceRoute(workspaceId));
}

interface MissingProvidersError extends DetailedError {
  detail: { data: { error: "missing_providers"; providers: string[] } };
}

/**
 * Type guard for the missing_providers error returned when importing a workspace
 * that requires providers the user hasn't configured.
 */
function isMissingProvidersError(error: unknown): error is MissingProvidersError {
  return (
    error instanceof DetailedError &&
    error.detail != null &&
    typeof error.detail === "object" &&
    "data" in error.detail &&
    error.detail.data != null &&
    typeof error.detail.data === "object" &&
    "error" in error.detail.data &&
    error.detail.data.error === "missing_providers" &&
    "providers" in error.detail.data &&
    Array.isArray(error.detail.data.providers)
  );
}

/**
 * Capitalizes a provider slug for display (e.g. "slack" -> "Slack", "google-drive" -> "Google Drive").
 */
function formatProviderName(provider: string): string {
  return provider
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
