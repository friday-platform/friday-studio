<script lang="ts">
import type { Snippet } from "svelte";
import { createSegmentControllerContext } from "./context.svelte";

let { children, variant = "outline" }: { children: Snippet; variant?: "filled" | "outline" } =
  $props();

createSegmentControllerContext({ variant });
</script>

<div class="variant--{variant}">
	{@render children()}
</div>

<style>
	div {
		align-items: center;
		block-size: var(--size-7);
		display: flex;
		gap: var(--size-2);
		transition: all 150ms ease-out;

		-webkit-user-select: none;
		-moz-user-select: none;
		user-select: none;

		&:not(:has(.item.active:matches(:first-child))) {
			margin-inline-start: calc(var(--size-2-5) * -1);
		}

		:global(a:not(.item)) {
			align-items: center;
			block-size: 100%;
			color: var(--text-3);
			font-size: var(--font-size-2);
			font-weight: var(--font-weight-5);
			cursor: default;
			display: flex;
			gap: var(--size-1-5);
			inline-size: max-content;
			padding-inline: var(--size-2-5);
			text-decoration-color: color-mix(in srgb, var(--text-3) 40%, transparent);
			text-underline-offset: var(--size-0-5);
			transition:
				all 150ms ease,
				color 150ms ease;

			&:focus-visible {
				border-radius: var(--radius-1);
				outline: 1px solid var(--accent-1);
			}

			&:hover {
				text-decoration-line: underline;
			}
		}
	}
</style>
