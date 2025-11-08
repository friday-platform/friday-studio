<script lang="ts">
import type { Snippet } from "svelte";

import { getContext } from "./context";

type Props = { children: Snippet; onclick?: () => void };
let { children, onclick }: Props = $props();
const { close } = getContext();
</script>

<button {...$close} {onclick} use:close>
	{@render children()}
</button>

<style>
	button {
		background: var(--color-surface-2);
		block-size: var(--size-7);
		border-radius: var(--radius-3);
		display: inline-block;
		font-size: var(--font-size-3);
		font-weight: var(--font-weight-5);
		outline: none;
		inline-size: 100%;
		transition: background-color 150ms ease;

		&:focus {
			outline: none;
		}

		&:hover {
			background-color: color-mix(in srgb, var(--color-surface-2), var(--color-text) 5%);
		}

		&:focus-visible {
			border-radius: var(--radius-3);
			outline: 1px solid var(--color-text);
			z-index: var(--layer-1);
		}
	}
</style>
