<script lang="ts">
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { onDestroy, onMount } from "svelte";
import { getAppContext } from "$lib/app-context.svelte";
import AppContainer from "$lib/components/app/container.svelte";
import AppSidebar from "$lib/components/app/sidebar.svelte";
import KeyboardListener from "$lib/components/keyboard-listener.svelte";
import NotificationPortal from "$lib/components/notification/portal.svelte";
import { setClientContext } from "$lib/modules/client/context.svelte";
import { setSpacesContext } from "$lib/modules/spaces/context.svelte";
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

  // Setup drag and drop for staged files in desktop builds
  // Note: Workspace file drops (.yml/.yaml) are handled by WorkspaceDropHandler
  if (__TAURI_BUILD__) {
    try {
      const webview = getCurrentWebview();
      if (webview) {
        unlisten = await webview.onDragDropEvent(async (event) => {
          if (event.payload.type === "drop") {
            for (const path of event.payload.paths) {
              // Skip workspace config files - handled by WorkspaceDropHandler
              if (path.endsWith(".yml") || path.endsWith(".yaml")) {
                continue;
              }

              const name = path.split("/").pop() || path;
              appCtx.stagedFiles.add({ name, size: 0, status: "ready" });
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

{#if __TAURI_BUILD__}
	<div class="titlebar" data-tauri-drag-region></div>
{/if}

<div role="region">
	<AppContainer>
		<AppSidebar />

		<main>
			<div class="app-content">
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
			</div>
		</main>
	</AppContainer>
</div>

<NotificationPortal />
<KeyboardListener />
<WorkspaceDropHandler />

<style>
	main {
		padding: var(--size-1-5);
	}

	.app-content {
		background-color: var(--color-surface-1);
		box-shadow: var(--shadow-1);
		border-radius: var(--radius-5) var(--radius-5) 1.25rem var(--radius-5);
		overflow: auto;
		scrollbar-width: thin;
		min-block-size: 100%;
	}

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
