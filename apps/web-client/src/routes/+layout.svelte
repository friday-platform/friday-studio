<script lang="ts">
import { onMount, onDestroy } from "svelte";
import { setAppContext } from "$lib/app-context.svelte";
import favicon from "$lib/assets/favicon.svg";
import AppContainer from "$lib/components/app/container.svelte";
import AppSidebar from "$lib/components/app/sidebar.svelte";
import KeyboardListener from "$lib/components/keyboard-listener.svelte";
import { setClientContext } from "$lib/modules/client/context.svelte";
import "../app.css";

const { children } = $props();

const { daemonClient, keyboard } = setAppContext();
const ctx = setClientContext(daemonClient);

$effect(() => {
  if (keyboard.state?.key === "escape" && ctx.atlasSessionId) {
    ctx.conversationClient?.cancelSession(ctx.atlasSessionId);
  }
});

onMount(() => {
  // Start health checks immediately
  ctx.checkHealth();
  // Ensure periodic health checks are running for auto-reconnect
  ctx.startHealthCheckInterval();
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
		<AppSidebar disabled={ctx.daemonStatus === 'error'} />

		<main>
			{@render children?.()}
		</main>
	</AppContainer>
</div>

<!--
Tracks and normalizes selection of all keys and modifiers including:
  - shift
  - metaKey: option/alt
  - command
  - control/ctrl
-->
<KeyboardListener />

<style>
	.titlebar {
		app-region: drag;
		block-size: 3.25rem;
		inset-block-start: 0;
		inset-inline: 0;
		position: absolute;
		z-index: var(--layer-5);
	}

	main {
		display: flex;
		align-items: center;
		justify-content: center;
		flex: 1 1 100%;
		overflow: hidden;
	}
</style>
