<script lang="ts">
// import { TrayIcon } from '@tauri-apps/api/tray';
import { onMount } from "svelte";
import { setAppContext } from "$lib/app-context.svelte";
import favicon from "$lib/assets/favicon.svg";
import AppContainer from "$lib/components/app/container.svelte";
import AppSidebar from "$lib/components/app/sidebar.svelte";
import KeyboardListener from "$lib/components/keyboard-listener.svelte";
import { setClientContext } from "$lib/modules/client/context.svelte";
import "../app.css";

const { children } = $props();

const { daemonClient, uploadFile, keyboard } = setAppContext();
const ctx = setClientContext(daemonClient);

$effect(() => {
  if (keyboard.state?.key === "escape" && ctx.atlasSessionId) {
    ctx.conversationClient?.cancelSession(ctx.atlasSessionId);
  }
});

async function sendDiagnostics() {
  let result = await Command.create("exec-sh", ["-c", "echo 'Hello World!'"]).execute();
  console.log("RESULT 📯", result);
}

onMount(async () => {
  ctx.checkHealth();

  const menu = await Menu.new({
    items: [{ id: "send-diagnostics", text: "Send Diagnostics", action: sendDiagnostics }],
  });

  const options = { menu, menuOnLeftClick: true, icon: "icons/tray.png", tooltip: "Tauri App" };

  await TrayIcon.new(options);
});
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
	main {
		display: flex;
		align-items: center;
		justify-content: center;
		flex: 1 1 100%;
		overflow: hidden;
	}
</style>
