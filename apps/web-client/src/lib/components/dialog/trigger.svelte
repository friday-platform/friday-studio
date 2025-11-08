<script lang="ts">
import type { Snippet } from "svelte";
import { getContext } from "./context";

const { trigger } = getContext();

type Props = { children: Snippet };

let { children }: Props = $props();
</script>

<button {...$trigger} use:trigger>
	{@render children()}
</button>

<style>
	button {
		display: contents;

		&:focus {
			outline: none;
		}

		&:focus-visible {
			border-radius: var(--radius-2);
			outline: 1px solid var(--color-text);
		}
	}
</style>
