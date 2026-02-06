<script lang="ts">
import { type Snippet } from "svelte";
import { expoOut } from "svelte/easing";
import type { HTMLAttributes } from "svelte/elements";
import { scale } from "svelte/transition";
import { getContext } from "./context";

type Props = { children: Snippet; visible?: boolean };

let node = $state<HTMLDivElement>();

let { children, visible = true, ...rest }: Props & HTMLAttributes<HTMLDivElement> = $props();

const { open, menu, positioning, overlay } = getContext();
</script>

{#if $open}
	<div class="overlay" {...$overlay} use:overlay></div>

	<div
		{...$menu}
		class="content size--auto placement--{$positioning?.placement ?? 'bottom'}"
		class:visible
		use:menu
		bind:this={node}
		in:scale={{ duration: 150, start: 0.96, easing: expoOut }}
		out:scale={{ start: 0.96, duration: 250, easing: expoOut }}
		{...rest}
	>
		{@render children()}
	</div>
{/if}

<style>
	.content {
		display: flex;
		flex-direction: column;
		outline: none;
		opacity: 1;
		overflow: auto;
		transform: translate3d(0, 0, 0);
		transition: opacity 100ms ease;
		visibility: visible;

		:global(body:has([role='dialog'][data-state='open'])) & {
			opacity: 0;
			overflow: hidden;
			visibility: hidden;
		}

		&.placement--top {
			transform-origin: 50% 100%;
		}

		&.placement--top-start {
			transform-origin: 0 100%;
		}

		&.placement--top-end {
			transform-origin: 100% 100%;
		}

		&.placement--right {
			transform-origin: 0 50%;
		}

		&.placement--right-end {
			transform-origin: 0 100%;
		}

		&.placement--bottom {
			transform-origin: 50% 0;
		}

		&.placement--right-start,
		&.placement--bottom-start {
			transform-origin: 0 0;
		}

		&.placement--bottom-end {
			transform-origin: 100% 0;
		}

		&.placement--left {
			transform-origin: 100% 50%;
		}

		&.placement--left-start {
			transform-origin: 100% 0;
		}

		&.placement--left-end {
			transform-origin: 100% 100%;
		}
	}

	.content.size--auto {
		--dropdown-menu-content-size: auto;
	}

	.overlay {
		inset: 0;
		position: fixed;
		z-index: var(--layer-2);
	}
</style>
