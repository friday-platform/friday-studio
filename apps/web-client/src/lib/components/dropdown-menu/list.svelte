<script lang="ts">
import { type Snippet } from "svelte";

type Props = { children: Snippet };

let { children }: Props = $props();
</script>

<div>
	{@render children()}
</div>

<style>
	div {
		block-size: 100%;
		display: flex;
		flex-direction: column;
		gap: var(--size-0-5);
		inline-size: 100%;
		max-block-size: var(--size-52);
		max-inline-size: var(--size-72);
		overflow-x: hidden;
		overflow-y: scroll;
		overscroll-behavior: none;
		transform: translate3d(0, 0, 0);
		scrollbar-width: none;
	}
</style>
