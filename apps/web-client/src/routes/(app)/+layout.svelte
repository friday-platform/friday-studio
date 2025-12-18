<script lang="ts">
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { onDestroy, onMount } from "svelte";
import { getAppContext, getFileType } from "$lib/app-context.svelte";
import favicon from "$lib/assets/favicon.svg";
import AppContainer from "$lib/components/app/container.svelte";
import AppSidebar from "$lib/components/app/sidebar.svelte";
import KeyboardListener from "$lib/components/keyboard-listener.svelte";
import NotificationPortal from "$lib/components/notification/portal.svelte";
import { setClientContext } from "$lib/modules/client/context.svelte";
import { setSpacesContext } from "$lib/modules/spaces/context.svelte";
import { handleWorkspaceFileDrop } from "$lib/modules/spaces/utils.svelte";
import WorkspaceDropHandler from "$lib/modules/spaces/workspace-drop-handler.svelte";

const { children } = $props();

const appCtx = getAppContext();
const spacesCtx = setSpacesContext();
const ctx = setClientContext();

let unlisten: (() => void) | undefined;

onMount(async () => {
  // Load spaces
  spacesCtx.fetchWorkspaces();

  // Start health checks immediately
  ctx.checkHealth();

  // Ensure periodic health checks are running for auto-reconnect
  ctx.startHealthCheckInterval();

  // Setup drag and drop for desktop builds
  if (__TAURI_BUILD__) {
    try {
      const webview = getCurrentWebview();
      if (webview) {
        unlisten = await webview.onDragDropEvent(async (event) => {
          if (event.payload.type === "drop") {
            for (const path of event.payload.paths) {
              // Check if it's a valid workspace config file
              if (path.endsWith(".yml") || path.endsWith(".yaml")) {
                const result = await handleWorkspaceFileDrop(path);
                if (result) {
                  // Valid workspace file - skip it, let WorkspaceDropHandler handle it
                  continue;
                }
              }

              appCtx.stagedFiles.add(path, { path, type: getFileType(path) });
            }
          }
        });
      }
    } catch (error) {
      console.error("Failed to setup drag and drop:", error);
    }
  }
});

onDestroy(() => {
  ctx.destroy();
  unlisten?.();
});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<div class="titlebar" data-tauri-drag-region></div>

<div role="region">
	<AppContainer>
		<AppSidebar />

		<main>
			{#if ctx.daemonStatus === 'error'}
				<div class="daemon-error">
					<p>
						The connection to Atlas was lost
						{#if ctx.reconnectCountdown > 0}
							<span class="reconnect-countdown">(reconnecting in {ctx.reconnectCountdown}s)</span>
						{:else if ctx.reconnectCountdown === 0}
							<span class="reconnect-countdown">(reconnecting...)</span>
						{/if}
					</p>
					<button type="button" onclick={() => ctx.checkHealth()}>Try again</button>
				</div>
			{/if}
			{@render children?.()}
		</main>
	</AppContainer>
</div>

<NotificationPortal />
<KeyboardListener />
<WorkspaceDropHandler />

<style>
	.titlebar {
		block-size: 3.25rem;
		inset-block-start: 0;
		inset-inline: 0;
		position: absolute;
		z-index: var(--layer-4);
	}

	main {
		display: flex;
		flex-direction: column;
		flex: 1 1 100%;
		overflow: hidden;
	}

	.daemon-error {
		align-items: center;
		background-color: color-mix(in srgb, #c5634d, transparent 90%);
		block-size: var(--size-13);
		display: flex;
		font-size: var(--font-size-2);
		font-weight: var(--font-weight-5);
		padding-inline: var(--size-5);
		justify-content: space-between;
		position: relative;
		z-index: var(--layer-5);

		button {
			color: #c5634d;
			cursor: pointer;
			margin-inline-start: var(--size-2);

			&:hover {
				text-decoration: underline;
			}

			@media (prefers-color-scheme: dark) {
				color: color-mix(in srgb, #c5634d, #fff 65%);
			}
		}
	}
</style>
