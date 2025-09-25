<script lang="ts">
import type { Snippet } from "svelte";
import { getAppContext } from "$lib/app-context.svelte";

let { children }: { children: Snippet } = $props();

const appCtx = getAppContext();
</script>

<div class:expanded={appCtx.sidebarExpanded}>
	{@render children()}
</div>

<style>
	div {
		block-size: 100dvh;
		display: grid;
		grid-template-columns: calc(var(--size-23) + var(--size-px)) 1fr;
		flex-direction: column;
		transition: all 0.2s ease-in-out;

		&.expanded {
			grid-template-columns: var(--size-56) 1fr;
		}
	}
</style>
