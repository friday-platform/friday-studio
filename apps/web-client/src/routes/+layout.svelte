<script lang="ts">
import { setAppContext } from "$lib/app-context.svelte";
import favicon from "$lib/assets/favicon.svg";
import AppContainer from "$lib/components/app/container.svelte";
import AppSidebar from "$lib/components/app/sidebar.svelte";
import KeyboardListener from "$lib/components/keyboard-listener.svelte";
import { setClientContext } from "$lib/modules/client/context.svelte";
import "../app.css";

const { children } = $props();

const { daemonClient, uploadFile } = setAppContext();
setClientContext(daemonClient);
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<div
	role="region"
	ondragover={(e) => {
		e.preventDefault();
	}}
	ondragleave={(e) => {
		e.preventDefault();
	}}
	ondrop={async (e) => {
		e.preventDefault();

		if (!e.dataTransfer?.items) {
			return;
		}

		for (const file of e.dataTransfer.files) {
			uploadFile(file);
		}
	}}
>
	<AppContainer>
		<AppSidebar />

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
	main {
		display: flex;
		align-items: center;
		justify-content: center;
		flex: 1 1 100%;
		overflow: hidden;
	}
</style>
