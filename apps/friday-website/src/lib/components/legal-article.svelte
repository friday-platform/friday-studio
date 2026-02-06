<script lang="ts">
import type { Snippet } from "svelte";

type Props = { children: Snippet };

let { children }: Props = $props();
</script>

<article class="legal">
	{@render children()}
</article>

<style>
	.legal {
		margin-inline: auto;
		max-inline-size: var(--size-224);
		padding-block: var(--size-12) var(--size-24);
		padding-inline: var(--size-6);

		@media (min-width: 768px) {
			padding-block: var(--size-16) var(--size-48);
		}
	}

	.legal :global(h1) {
		font-size: var(--font-size-7);
		font-weight: var(--font-weight-6);
		letter-spacing: calc(-1 * var(--font-letterspacing-1));
		line-height: var(--font-lineheight-1);
	}

	.legal :global(h2) {
		font-size: var(--font-size-6);
		font-weight: var(--font-weight-6);
		line-height: var(--font-lineheight-1);
		margin-block: var(--size-8) var(--size-3);
	}

	.legal :global(p) {
		font-size: var(--font-size-4);
		line-height: var(--font-lineheight-3);
		margin-block: var(--size-3) 0;
		max-inline-size: 80ch;
		opacity: 0.8;
	}

	.legal :global(a) {
		color: var(--color-blue-2);
		text-decoration: underline;
	}
</style>
