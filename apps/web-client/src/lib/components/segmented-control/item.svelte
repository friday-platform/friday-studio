<script lang="ts">
import type { Snippet } from "svelte";
import type { HTMLAnchorAttributes } from "svelte/elements";
import { getSegmentControllerContext } from "./context.svelte";

type Props = { children: Snippet; href: string; active?: boolean; hideWhenInactive?: boolean };

let {
  children,
  href,
  active = false,
  hideWhenInactive = false,
  ...rest
}: Props & HTMLAnchorAttributes = $props();

const { variant } = getSegmentControllerContext();
</script>

{#if !hideWhenInactive || active}
	<a {href} class="item {active ? 'active' : ''} variant--{variant}" {...rest}>
		{@render children()}
	</a>
{/if}

<style>
	.item {
		--transparency: 40%;
		align-items: center;
		block-size: 100%;

		border: var(--size-px) solid transparent;
		border-radius: var(--radius-round);
		color: var(--text-3);
		font-size: var(--font-size-4);
		font-weight: var(--font-weight-5);
		cursor: default;
		display: flex;
		inline-size: max-content;
		padding-inline: var(--size-2-5);
		position: relative;
		transition:
			all 150ms ease,
			color 150ms ease;

		&.variant--outline {
			background-color: var(--background-1);
		}
	}

	.active {
		--transparency: 0%;
		background-color: var(--highlight-2);
		color: var(--text-1);

		&.variant--outline {
			border: var(--size-px) solid var(--border-3);
		}
	}

	.item:focus-visible {
		border-radius: var(--radius-1);
		outline: 1px solid var(--accent-1);
	}

	.item:not(.active):hover {
		--transparency: 0%;
		border-color: var(--border-3);
	}

	.item.active {
		& :global(+ .tempest--component__separator) {
			margin-inline-start: var(--size-2);
		}
	}
</style>
