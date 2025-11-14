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
		&:focus {
			outline: none;
		}
	}
</style>
