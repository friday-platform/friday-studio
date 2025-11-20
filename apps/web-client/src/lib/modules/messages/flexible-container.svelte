<script lang="ts">
import type { Snippet } from "svelte";

let { children }: { children: Snippet } = $props();
</script>

<div class="flexible-container">
	{@render children()}
</div>

<style>
	.flexible-container {
		margin-inline: auto;
		max-inline-size: 100%;
		min-inline-size: var(--size-160);
		inline-size: max-content;
		padding-inline: var(--size-8);
	}
</style>
