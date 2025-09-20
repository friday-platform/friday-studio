<script lang="ts">
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { onDestroy, onMount } from "svelte";
import { getFileType, setAppContext } from "$lib/app-context.svelte";
import favicon from "$lib/assets/favicon.svg";
import AboutDialog from "$lib/components/about-dialog.svelte";
import DiagnosticsDialog from "$lib/components/diagnostics-dialog.svelte";
import AppContainer from "$lib/components/app/container.svelte";
import AppSidebar from "$lib/components/app/sidebar.svelte";
import KeyboardListener from "$lib/components/keyboard-listener.svelte";
import { setClientContext } from "$lib/modules/client/context.svelte";
import "../app.css";

const { children } = $props();

const { daemonClient, keyboard, stagedFiles } = setAppContext();

const ctx = setClientContext(daemonClient);

let showAboutDialog = $state(false);
let showDiagnosticsDialog = $state(false);

$effect(() => {
  if (keyboard.state?.key === "escape" && ctx.atlasSessionId) {
    ctx.conversationClient?.cancelSession(ctx.atlasSessionId);
  }
});

onMount(() => {
  if (!ctx.conversationClient) {
    ctx.connect();
  }

  // Start health checks immediately
  ctx.checkHealth();

  // Ensure periodic health checks are running for auto-reconnect
  ctx.startHealthCheckInterval();

  // Listen for dialog events from Tauri
  let unlistenAbout: (() => void) | undefined;
  let unlistenDiagnostics: (() => void) | undefined;

  async function setupDialogListeners() {
    try {
      const { listen } = await import("@tauri-apps/api/event");
      unlistenAbout = await listen("show-about-dialog", () => {
        showAboutDialog = true;
      });
      unlistenDiagnostics = await listen("show-diagnostics-dialog", () => {
        showDiagnosticsDialog = true;
      });
    } catch {
      // Not in Tauri context
    }
  }
  setupDialogListeners();

  // Drag and drop support
  let unlisten: () => void = () => {};

  async function setupDragDrop() {
    unlisten = await getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "drop") {
        stagedFiles.add(event.payload.paths[0], {
          path: event.payload.paths[0],
          type: getFileType(event.payload.paths[0]),
        });
      }
    });
  }

  setupDragDrop();

  return () => {
    // you need to call unlisten if your handler goes out of scope e.g. the component is unmounted
    unlisten();
    unlistenAbout?.();
    unlistenDiagnostics?.();
  };
});

onDestroy(() => {
  ctx.destroy();
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

<KeyboardListener />
<AboutDialog bind:open={showAboutDialog} />
<DiagnosticsDialog bind:open={showDiagnosticsDialog} />

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
		font-size: var(--font-size-1);
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
