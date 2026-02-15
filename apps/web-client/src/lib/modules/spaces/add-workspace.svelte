<script lang="ts">
  import { GA4, trackEvent } from "@atlas/analytics/ga4";
  import type { WorkspaceConfig } from "@atlas/config";
  import { useQueryClient } from "@tanstack/svelte-query";
  import { getAppContext } from "$lib/app-context.svelte";
  import { Dialog } from "$lib/components/dialog";
  import { Icons } from "$lib/components/icons";
  import type { Snippet } from "svelte";
  import MissingCredentialsDialog from "./missing-credentials-dialog.svelte";
  import {
    addWorkspace,
    CredentialRetryState,
    handleWorkspaceFile,
    MissingCredentialsError,
  } from "./utils.svelte";

  let { triggerContents }: { triggerContents: Snippet } = $props();

  let queryClient = useQueryClient();
  const appCtx = getAppContext();

  let workspaceConfig = $state<WorkspaceConfig | null>(null);
  let fileInputEl: HTMLInputElement | null = null;

  function captureFileInput(node: HTMLInputElement) {
    fileInputEl = node;
  }

  const credRetry = new CredentialRetryState();

  async function handleFileSelected() {
    if (!fileInputEl) return;
    const file = fileInputEl.files?.[0];

    if (!file) return;

    trackEvent(GA4.WORKSPACE_FILE_SELECT);
    const result = await handleWorkspaceFile(file);
    if (result) {
      workspaceConfig = result.config;
    }

    // Reset input so the same file can be selected again
    fileInputEl.value = "";
  }

  function handleDragOver(e: DragEvent) {
    if (e.dataTransfer?.types.includes("Files")) {
      e.preventDefault();
    }
  }

  async function handleDrop(e: DragEvent) {
    const file = e.dataTransfer?.files[0];
    if (!file) return;

    e.preventDefault();

    trackEvent(GA4.WORKSPACE_FILE_DROP);
    const result = await handleWorkspaceFile(file);
    if (result) {
      workspaceConfig = result.config;
    }
  }

  // Add document-level drop handlers when dialog is open
  $effect(() => {
    if (!appCtx.addWorkspaceDialogOpen) return;

    document.addEventListener("dragover", handleDragOver);
    document.addEventListener("drop", handleDrop);

    return () => {
      document.removeEventListener("dragover", handleDragOver);
      document.removeEventListener("drop", handleDrop);
    };
  });
</script>

<input type="file" accept=".yml,.yaml" use:captureFileInput onchange={handleFileSelected} hidden />

<Dialog.Root
  onOpenChange={({ next }) => {
    if (next) {
      trackEvent(GA4.WORKSPACE_DIALOG_OPEN);
    }
    appCtx.addWorkspaceDialogOpen = next;

    if (!next) {
      workspaceConfig = null;
    }

    return next;
  }}
>
  {#snippet children(open)}
    <Dialog.Trigger>
      {@render triggerContents()}
    </Dialog.Trigger>

    <Dialog.Content>
      <Dialog.Close />

      {#snippet icon()}
        <span style:color="var(--color-blue)">
          <Icons.Workspace />
        </span>
      {/snippet}

      {#snippet header()}
        <Dialog.Title>New Space</Dialog.Title>
        <Dialog.Description>
          {#if workspaceConfig?.workspace.name}
            <p>Add a Space for "{workspaceConfig.workspace.name}"?</p>
          {:else}
            <p>Add a new Space by selecting and uploading a workspace config file</p>
          {/if}
        </Dialog.Description>
      {/snippet}

      {#snippet footer()}
        {#if workspaceConfig}
          <Dialog.Button
            closeOnClick={false}
            onclick={async () => {
              if (!workspaceConfig) return;

              try {
                trackEvent(GA4.WORKSPACE_CREATE, {
                  workspace_name: workspaceConfig.workspace.name,
                });
                await addWorkspace(workspaceConfig, {
                  refreshWorkspaces: () =>
                    queryClient.invalidateQueries({ queryKey: ["spaces"], refetchType: "all" }),
                  getSpaceRoute: (id: string) => appCtx.routes.spaces.item(id),
                });

                open.set(false);
              } catch (error) {
                if (error instanceof MissingCredentialsError) {
                  credRetry.handleError(workspaceConfig, error);
                  open.set(false);
                } else {
                  console.error("Failed to add workspace:", error);
                }
              }
            }}
          >
            Create Space
          </Dialog.Button>
        {:else}
          <Dialog.Button
            closeOnClick={false}
            onclick={() => {
              trackEvent(GA4.WORKSPACE_FILE_PICKER_CLICK);
              fileInputEl?.click();
            }}
          >
            Select File
          </Dialog.Button>
        {/if}
        <Dialog.Cancel>Cancel</Dialog.Cancel>
      {/snippet}
    </Dialog.Content>
  {/snippet}
</Dialog.Root>

<MissingCredentialsDialog
  missingProviders={credRetry.missingProviders}
  providerKeys={credRetry.providerKeys}
  continueDisabled={credRetry.retrying}
  open={credRetry.openStore}
  onComplete={async () => {
    await credRetry.retry({
      refreshWorkspaces: () =>
        queryClient.invalidateQueries({ queryKey: ["spaces"], refetchType: "all" }),
      getSpaceRoute: (id: string) => appCtx.routes.spaces.item(id),
    });
  }}
/>
