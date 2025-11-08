<script lang="ts">
import type { Snippet } from "svelte";

const { children }: { children: Snippet } = $props();
</script>

<div class="component">
	{@render children()}
</div>

<style>
	.component {
		margin-inline: auto;
		max-inline-size: var(--size-150);
		inline-size: 100%;
		padding-inline: var(--size-1);
		position: relative;
		z-index: var(--layer-1);
	}
</style>
