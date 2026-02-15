import { client, DetailedError, parseResult } from "@atlas/client/v2";
import { WorkspaceConfigSchema, type WorkspaceConfig } from "@atlas/config";
import { parse } from "@std/yaml";
import { goto } from "$app/navigation";
import { toast } from "$lib/components/notification/notification.svelte";
import { toStore } from "svelte/store";
import { z, ZodError } from "zod";

const MissingCredentialsResponseSchema = z.object({
  error: z.literal("missing_credentials"),
  missingProviders: z.array(z.string()),
  providerKeys: z.record(z.string(), z.array(z.string())).optional(),
});

export class MissingCredentialsError extends Error {
  constructor(
    public readonly providers: string[],
    public readonly providerKeys: Record<string, string[]>,
  ) {
    super("missing_credentials");
    this.name = "MissingCredentialsError";
  }
}

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

    if (res.error instanceof DetailedError) {
      const parsed = MissingCredentialsResponseSchema.safeParse(res.error.detail?.data);
      if (parsed.success) {
        throw new MissingCredentialsError(
          parsed.data.missingProviders,
          parsed.data.providerKeys ?? {},
        );
      }
    }

    throw new Error(typeof res.error === "string" ? res.error : "Failed to add workspace");
  }

  const workspaceId = res.data.workspace.id;

  // Refresh the workspaces list in the sidebar
  options.refreshWorkspaces();

  // Navigate to the new workspace
  await goto(options.getSpaceRoute(workspaceId));
}

/**
 * Shared state for the MissingCredentialsDialog retry flow.
 * Used by both add-workspace and workspace-drop-handler to avoid duplicating
 * the state management, store adapter, and retry logic.
 */
export class CredentialRetryState {
  missingProviders = $state<string[]>([]);
  providerKeys = $state<Record<string, string[]>>({});
  showDialog = $state(false);
  pendingConfig = $state<WorkspaceConfig | null>(null);
  retrying = $state(false);

  get openStore() {
    return toStore(
      () => this.showDialog,
      (value: boolean) => {
        this.showDialog = value;
        if (!value) this.reset();
      },
    );
  }

  reset() {
    this.pendingConfig = null;
    this.missingProviders = [];
    this.providerKeys = {};
  }

  handleError(config: WorkspaceConfig, error: MissingCredentialsError) {
    this.pendingConfig = config;
    this.missingProviders = error.providers;
    this.providerKeys = error.providerKeys;
    this.showDialog = true;
  }

  async retry(options: { refreshWorkspaces: () => void; getSpaceRoute: (id: string) => string }) {
    if (!this.pendingConfig || this.retrying) return;
    this.retrying = true;
    try {
      await addWorkspace(this.pendingConfig, options);
      this.pendingConfig = null;
      this.missingProviders = [];
      this.providerKeys = {};
    } catch (error) {
      if (error instanceof MissingCredentialsError) {
        this.missingProviders = error.providers;
        this.providerKeys = error.providerKeys;
        this.showDialog = true;
      } else {
        this.reset();
        console.error("Failed to add workspace on retry:", error);
      }
    } finally {
      this.retrying = false;
    }
  }
}
