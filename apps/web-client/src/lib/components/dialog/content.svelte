<script lang="ts">
import type { Snippet } from "svelte";
import { quadInOut } from "svelte/easing";
import { fade, scale } from "svelte/transition";
import { getContext } from "./context";

type Props = { children: Snippet };

let { children }: Props = $props();

const { content, portalled, overlay, open } = getContext();
</script>

{#if $open}
	<div class="component" {...$portalled} use:portalled>
		<div
			{...$overlay}
			use:overlay
			class="overlay"
			transition:fade={{ duration: 150, easing: quadInOut }}
		></div>

		<div
			class="dialog"
			{...$content}
			use:content
			transition:scale={{ duration: 150, start: 0.98, easing: quadInOut, opacity: 0 }}
		>
			{@render children()}
		</div>
	</div>
{/if}

<style>
	.component {
		align-items: center;
		display: flex;
		justify-content: center;
		inset: 0;
		padding-inline-start: var(--size-56);
		position: fixed;
		z-index: var(--layer-3);
	}

	.overlay {
		background: radial-gradient(
			ellipse closest-side at 50% 50%,
			var(--color-surface-2) 0%,
			transparent 100%
		);
		inset: 0;
		inset-inline-start: var(--size-56);
		opacity: 0.5;
		position: absolute;
		z-index: -1;
	}

	.dialog {
		-webkit-user-select: auto;
		-moz-user-select: auto;
		user-select: auto;

		background: var(--color-surface-1);
		border-radius: var(--radius-5);
		box-shadow: var(--shadow-1);
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: var(--size-6);
		inline-size: 100%;
		max-inline-size: var(--size-80);
		padding: var(--size-12);
		padding-block-end: var(--size-8);
		position: relative;
		text-align: center;
	}
</style>
