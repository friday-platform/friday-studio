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
		display: flex;
		flex-direction: column;
	}
</style>
