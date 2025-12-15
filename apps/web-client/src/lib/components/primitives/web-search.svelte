<script lang="ts">
import type { WebSearchData } from "@atlas/core/artifacts";
import MarkdownContent from "$lib/components/primitives/markdown-content.svelte";

type Props = { data: WebSearchData };

let { data }: Props = $props();
</script>

<MarkdownContent content={data.response} />

<div class="sources">
	{#each data.sources as source, index ((source.url, index))}
		<a href={source.url} target="_blank">
			<article>
				<h2>{source.pageTitle}</h2>
				<p>{source.siteName}</p>
			</article>
		</a>
	{/each}
</div>

<style>
	.sources {
		display: grid;
		grid-auto-flow: column;
		align-items: stretch;
		justify-content: start;
		gap: var(--size-2);
		margin-block-start: var(--size-2);

		a {
			border: var(--size-px) solid var(--color-border-1);
			border-radius: var(--radius-3);
			display: block;
			overflow: hidden;
			transition: all 0.2s ease;

			&:hover {
				background-color: var(--color-surface-2);
			}
		}

		article {
			block-size: 100%;
			display: flex;
			flex-direction: column;
			inline-size: var(--size-44);
			gap: var(--size-1);
			padding: var(--size-3);

			h2 {
				font-size: var(--font-size-2);
				font-weight: var(--font-weight-5);
				line-height: var(--font-lineheight-1);

				display: -webkit-box;
				-webkit-box-orient: vertical;
				overflow: hidden;
				text-overflow: ellipsis;
				-webkit-line-clamp: 2;
			}

			p {
				font-size: var(--font-size-1);

				opacity: 0.6;
			}
		}
	}
</style>
