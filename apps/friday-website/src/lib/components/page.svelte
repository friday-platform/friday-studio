<script lang="ts">
import type { Snippet } from "svelte";

let { children }: { children: Snippet } = $props();
</script>

<div>
	{@render children()}
</div>

<style>
	div {
		margin-inline: auto;
		max-inline-size: 80ch;
		padding-block: var(--size-12) var(--size-24);
		padding-inline: var(--size-6);

		@media (min-width: 768px) {
			padding-block: var(--size-16) var(--size-48);
		}

		& :global(h1) {
			font-size: var(--font-size-7);
			font-weight: var(--font-weight-6);
			letter-spacing: calc(-1 * var(--font-letterspacing-1));
			line-height: var(--font-lineheight-1);
			margin-block: 0 var(--size-6);
			text-wrap-style: balance;
		}

		& :global(iframe) {
			margin-block: var(--size-4);
			max-inline-size: 100%;
		}

		& :global(p) {
			font-size: var(--font-size-5);
			line-height: var(--font-lineheight-3);
			margin-block: var(--size-4) 0;
			opacity: 0.8;
			text-wrap-style: pretty;
		}

		& :global(ul) {
			font-size: var(--font-size-5);
			line-height: var(--font-lineheight-3);
			list-style: disc;
			margin-block: var(--size-2) 0;
			max-inline-size: 80ch;
			opacity: 0.8;
			padding-inline: var(--size-6);

			& :global(li) {
				margin-block: var(--size-1) 0;
			}
		}

		& :global(address) {
			font-size: var(--font-size-5);
			font-style: normal;
			font-weight: var(--font-weight-5);
			line-height: var(--font-lineheight-3);
			margin-block: var(--size-3) 0;
			opacity: 0.8;
		}

		& :global(a) {
			color: var(--color-blue-2);
			text-decoration: underline;
		}
	}
</style>
