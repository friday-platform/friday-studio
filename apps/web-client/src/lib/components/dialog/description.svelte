<script lang="ts">
import type { Snippet } from "svelte";
import { getContext } from "./context";

type Props = { children: Snippet };
let { children }: Props = $props();

const { description } = getContext();
</script>

<div {...$description} use:description>
	{@render children()}
</div>

<style>
	div {
		& :global(p) {
			font-size: var(--font-size-4);
			line-height: var(--font-lineheight-3);
			opacity: 0.7;
			text-wrap-mode: balance;
		}

		& :global(p + p) {
			padding-block-start: var(--size-2);
		}

		& :global strong {
			font-weight: var(--font-weight-6);
		}
	}
</style>
