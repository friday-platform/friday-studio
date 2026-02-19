<script lang="ts">
import { type Snippet } from "svelte";
import type { Writable } from "svelte/store";
import { createContext } from "./context";

type Props = { children: Snippet<[Writable<boolean>]> };

const { children }: Props = $props();

const { open } = createContext({ forceVisible: true, closeOnOutsideClick: true });
</script>

{@render children(open)}

<style>
	:global([data-melt-dropdown-menu]) {
		--dropdown-menu-content-padding: var(--size-4);
		--dropdown-menu-content-size: auto;

		background-color: var(--color-canvas-light);
		border-radius: var(--radius-4);
		box-shadow: var(--shadow-1);
		inline-size: var(--dropdown-menu-content-size, auto);
		min-inline-size: var(--size-40);
		padding-block: var(--size-1);
		position: relative;
		z-index: var(--layer-3);
	}
</style>
