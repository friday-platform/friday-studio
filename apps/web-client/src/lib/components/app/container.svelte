<script lang="ts">
import type { Snippet } from "svelte";

let { children }: { children: Snippet } = $props();
</script>

<div>
	{@render children()}
</div>

<style>
	div {
		block-size: 100dvh;
		display: grid;
		grid-template-columns: 12.6875rem 1fr;
		flex-direction: column;
	}
</style>
