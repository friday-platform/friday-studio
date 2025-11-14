<script lang="ts">
import type { WorkspaceConfig } from "@atlas/config";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { onDestroy, onMount } from "svelte";
import { toStore, writable } from "svelte/store";
import { getAppContext, getFileType } from "$lib/app-context.svelte";
import { Dialog } from "$lib/components/dialog";
import { Icons } from "$lib/components/icons";
import { addWorkspace, handleWorkspaceFileDrop } from "./utils.svelte";

const appCtx = getAppContext();

let unlisten: (() => void) | undefined;
let isUploading = $state(false);
let workspaceConfig = $state<WorkspaceConfig | null>(null);

let showDialog = $state(false);
let open = writable(true);

onMount(() => {
  async function setupDragDrop() {
    if (__TAURI_BUILD__) {
      unlisten = await getCurrentWebview().onDragDropEvent(async (event) => {
        // Skip if add-workspace dialog is open
        if (appCtx.addWorkspaceDialogOpen) return;

        if (event.payload.type === "drop") {
          for (const path of event.payload.paths) {
            const result = await handleWorkspaceFileDrop(path);

            if (result) {
              workspaceConfig = result.config;
              showDialog = true;
            }
          }
        }
      });
    }
  }

  setupDragDrop();
});

onDestroy(() => {
  if (unlisten) {
    unlisten();
  }
});
</script>

<Dialog.Root
	open={toStore(
		() => showDialog,
		(value) => {
			showDialog = value;
		}
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
				<p>Upload and add a Space for “{workspaceConfig?.workspace.name}”?</p>
			</Dialog.Description>
		{/snippet}

		{#snippet footer()}
			<Dialog.Button
				onclick={async () => {
					if (!workspaceConfig) return;

					isUploading = true;

					try {
						await addWorkspace(workspaceConfig, {
							refreshWorkspaces: () => appCtx.refreshWorkspaces(),
							getSpaceRoute: (id: string) => appCtx.routes.spaces.item(id)
						});
					} catch (error) {
						console.error('Failed to add workspace:', error);
					} finally {
						isUploading = false;
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
