<script lang="ts">
import type { WorkspaceConfig } from "@atlas/config";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { Snippet } from "svelte";
import { onDestroy, onMount } from "svelte";
import { getAppContext } from "$lib/app-context.svelte";
import { Dialog } from "$lib/components/dialog";
import { Icons } from "$lib/components/icons";
import { invoke } from "$lib/utils/tauri-loader";
import { addWorkspace, handleWorkspaceFileDrop } from "./utils.svelte";

let { triggerContents }: { triggerContents: Snippet } = $props();

const appCtx = getAppContext();

let workspaceConfig = $state<WorkspaceConfig | null>(null);
let isCreating = $state(false);
let unlisten: (() => void) | undefined;

async function handleSelectFile() {
  if (!invoke) return;

  try {
    const paths = (await invoke("open_file_or_folder_picker", {
      multiple: false,
      foldersOnly: false,
    })) as string[];

    if (paths && paths.length > 0) {
      const result = await handleWorkspaceFileDrop(paths[0]);
      if (result) {
        workspaceConfig = result.config;
      }
    }
  } catch (error) {
    console.error("Failed to open file picker:", error);
  }
}

onMount(() => {
  async function setupDragDrop() {
    if (__TAURI_BUILD__) {
      unlisten = await getCurrentWebview().onDragDropEvent(async (event) => {
        // Only handle drops if this dialog is open
        if (!appCtx.addWorkspaceDialogOpen) return;

        if (event.payload.type === "drop") {
          for (const path of event.payload.paths) {
            const result = await handleWorkspaceFileDrop(path);

            if (result) {
              workspaceConfig = result.config;
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
									refreshWorkspaces: () => appCtx.refreshWorkspaces(),
									getSpaceRoute: (id: string) => appCtx.routes.spaces.item(id)
								});

								open.set(false);
							} catch (error) {
								console.error('Failed to add workspace:', error);
							} finally {
								isCreating = false;
							}
						}}
					>
						Create Space
					</Dialog.Button>
				{:else}
					<Dialog.Button closeOnClick={false} onclick={handleSelectFile}>Select File</Dialog.Button>
				{/if}
				<Dialog.Cancel>Cancel</Dialog.Cancel>
			{/snippet}
		</Dialog.Content>
	{/snippet}
</Dialog.Root>
