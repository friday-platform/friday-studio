<script lang="ts">
  import type { WorkspaceConfig } from "@atlas/config";
  import { getAppContext } from "$lib/app-context.svelte";
  import { Dialog } from "$lib/components/dialog";
  import { Icons } from "$lib/components/icons";
  import { toStore } from "svelte/store";
  import { getSpacesContext } from "./context.svelte";
  import { addWorkspace, handleWorkspaceFile } from "./utils.svelte";

  const appCtx = getAppContext();
  const spacesCtx = getSpacesContext();

  let workspaceConfig = $state<WorkspaceConfig | null>(null);
  let showDialog = $state(false);

  function handleDragOver(e: DragEvent) {
    // Must preventDefault to allow drop
    if (e.dataTransfer?.types.includes("Files")) {
      e.preventDefault();
    }
  }

  async function handleDrop(e: DragEvent) {
    // Skip if add-workspace dialog is open (let that component handle it)
    if (appCtx.addWorkspaceDialogOpen) return;

    const file = e.dataTransfer?.files[0];
    if (!file) return;

    e.preventDefault();

    const result = await handleWorkspaceFile(file);
    if (result) {
      workspaceConfig = result.config;
      showDialog = true;
    }
  }
</script>

<svelte:document ondragover={handleDragOver} ondrop={handleDrop} />

<Dialog.Root
  open={toStore(
    () => showDialog,
    (value) => {
      showDialog = value;
    },
  )}
>
  <Dialog.Content>
    <Dialog.Close />

    {#snippet icon()}
      <span style:color="var(--color-blue)">
        <Icons.Workspace />
      </span>
    {/snippet}

    {#snippet header()}
      <Dialog.Title>Add Space</Dialog.Title>
      <Dialog.Description>
        <p>Upload and add a Space for "{workspaceConfig?.workspace.name}"?</p>
      </Dialog.Description>
    {/snippet}

    {#snippet footer()}
      <Dialog.Button
        onclick={async () => {
          if (!workspaceConfig) return;

          try {
            await addWorkspace(workspaceConfig, {
              refreshWorkspaces: () => spacesCtx.fetchWorkspaces(),
              getSpaceRoute: (id: string) => appCtx.routes.spaces.item(id),
            });
          } catch (error) {
            console.error("Failed to add workspace:", error);
          } finally {
            workspaceConfig = null;
            showDialog = false;
          }
        }}
      >
        Confirm
      </Dialog.Button>
      <Dialog.Cancel>Cancel</Dialog.Cancel>
    {/snippet}
  </Dialog.Content>
</Dialog.Root>
