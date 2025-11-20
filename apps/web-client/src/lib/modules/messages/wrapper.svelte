<script lang="ts">
import type { Snippet } from "svelte";

const { children }: { children: Snippet } = $props();
</script>

<div class="component">
	{@render children()}
</div>

<style>
	.component {
		position: relative;
		z-index: var(--layer-1);
	}
</style>
