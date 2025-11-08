<script lang="ts">
import type { Snippet } from "svelte";
import type { HTMLAnchorAttributes } from "svelte/elements";

type Props = { children: Snippet; href: string; active?: boolean };

let { children, href, active = false, ...rest }: Props & HTMLAnchorAttributes = $props();
</script>

<a {href} class="item {active ? 'active' : ''}" {...rest}>
	{@render children()}
</a>

<style>
	.item {
		align-items: center;
		block-size: 100%;
		border: var(--size-px) solid transparent;
		border-radius: var(--radius-2-5);
		font-size: var(--font-size-2);
		font-weight: var(--font-weight-5);
		color: color-mix(in srgb, var(--color-text), transparent 40%);
		cursor: default;
		display: flex;
		inline-size: max-content;
		padding-inline: var(--size-2);
		position: relative;
		transition:
			all 150ms ease,
			color 150ms ease;
	}

	.active {
		border-color: var(--color-border-1);
		color: var(--color-text);
	}

	.item:focus-visible {
		border-radius: var(--radius-1);
		outline: 1px solid var(--accent-1);
	}

	.item:not(.active):hover {
		border-color: var(--color-border-1);
	}
</style>
