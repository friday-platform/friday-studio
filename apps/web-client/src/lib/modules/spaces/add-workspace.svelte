<script lang="ts">
  import type { WorkspaceConfig } from "@atlas/config";
  import { getAppContext } from "$lib/app-context.svelte";
  import { Dialog } from "$lib/components/dialog";
  import { Icons } from "$lib/components/icons";
  import type { Snippet } from "svelte";
  import { getSpacesContext } from "./context.svelte";
  import { addWorkspace, handleWorkspaceFile } from "./utils.svelte";

  let { triggerContents }: { triggerContents: Snippet } = $props();

  const appCtx = getAppContext();
  const spacesCtx = getSpacesContext();

  let workspaceConfig = $state<WorkspaceConfig | null>(null);
  let fileInput: HTMLInputElement;

  async function handleFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];

    if (!file) return;

    const result = await handleWorkspaceFile(file);
    if (result) {
      workspaceConfig = result.config;
    }

    // Reset input so the same file can be selected again
    input.value = "";
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

<input type="file" accept=".yml,.yaml" bind:this={fileInput} onchange={handleFileSelected} hidden />

<Dialog.Root
  onOpenChange={({ next }) => {
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
                await addWorkspace(workspaceConfig, {
                  refreshWorkspaces: () => spacesCtx.fetchWorkspaces(),
                  getSpaceRoute: (id: string) => appCtx.routes.spaces.item(id),
                });

                open.set(false);
              } catch (error) {
                console.error("Failed to add workspace:", error);
              }
            }}
          >
            Create Space
          </Dialog.Button>
        {:else}
          <Dialog.Button closeOnClick={false} onclick={() => fileInput.click()}>
            Select File
          </Dialog.Button>
        {/if}
        <Dialog.Cancel>Cancel</Dialog.Cancel>
      {/snippet}
    </Dialog.Content>
  {/snippet}
</Dialog.Root>
