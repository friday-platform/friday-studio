<script lang="ts">
import type { Snippet } from "svelte";

type Props = { header: Snippet; details: { title: string; description: string }[] };

let { header, details }: Props = $props();
</script>

<section>
	<header>
		{@render header()}
	</header>

	{#each details as detail, index (index)}
		<div>
			<p>{detail.title}</p>
		</div>
	{/each}
</section>

<style>
	section {
		gap: var(--size-12);
		margin-inline: auto;
		max-inline-size: var(--size-224);
		padding-block: var(--size-16) 0;
		padding-inline: var(--size-6);

		@media (min-width: 768px) {
			display: grid;
			grid-template-columns: 1fr 1fr 1fr;
			grid-template-rows: auto auto;
			padding-block: var(--size-24) 0;
		}
	}

	header {
		grid-column: 1 / span 2;

		& :global(h2) {
			align-items: center;
			display: flex;
			gap: var(--size-1);
			font-size: var(--font-size-5);
			font-weight: var(--font-weight-5);
			line-height: var(--font-lineheight-0);
		}
	}

	header :global(h3) {
		font-size: var(--font-size-7);
		font-weight: var(--font-weight-6);
		letter-spacing: calc(-1 * var(--font-letterspacing-1));
		line-height: var(--font-lineheight-1);
		padding-block: var(--size-4) 0;
		text-wrap-style: pretty;
	}

	div {
		margin-block: var(--size-6) 0;
		grid-row: 2;

		p {
			font-size: var(--font-size-6);
			font-weight: var(--font-weight-5);
			line-height: var(--font-lineheight-1);
			opacity: 0.8;
			text-wrap-style: balance;
		}
	}
</style>
