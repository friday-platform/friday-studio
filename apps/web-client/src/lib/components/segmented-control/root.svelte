<script lang="ts">
import type { Snippet } from "svelte";

let { children, variant = "filled" }: { children: Snippet; variant?: "filled" | "outline" } =
  $props();
</script>

<div class="variant--{variant}">
	{@render children()}
</div>

<style>
	div {
		align-items: center;
		block-size: var(--size-6);
		display: flex;
		gap: var(--size-1);
		transition: all 150ms ease-out;

		-webkit-user-select: none;
		-moz-user-select: none;
		user-select: none;
	}
</style>
