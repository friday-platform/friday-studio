<script lang="ts">
import type { SlackSummaryData, SummaryData } from "@atlas/core/artifacts";
import Document from "$lib/components/primitives/document.svelte";
import { markdownToHTML } from "$lib/modules/messages/markdown-utils";

type Props = { data: SummaryData | SlackSummaryData; source?: "slack" };

let { data, source }: Props = $props();
const htmlContent = $derived(markdownToHTML(data));
</script>

<Document name={source === 'slack' ? 'Slack Summary' : 'Search Result'}>
	<div class="summary">
		{@html htmlContent}
	</div>
</Document>

<style>
	.summary {
		& {
			padding: var(--size-6);
		}

		& :global(h1) {
			font-size: var(--font-size-7);
			font-weight: var(--font-weight-6);
			line-height: var(--font-lineheight-0);
		}

		& :global(p),
		& :global(li) {
			color: var(--text-1);
			opacity: 0.8;
			font-size: var(--font-size-4);
			line-height: var(--font-lineheight-3);
		}

		& :global(li li) {
			opacity: 1;
		}

		& :global(p),
		& :global(ul),
		& :global(ol) {
			&:global(:has(+ ul, + ol, + p)) {
				margin-block-end: var(--size-1-5);
			}
		}

		& :global(ul) {
			list-style-type: '⋅ ';
			margin-inline-start: var(--size-4);
		}

		& :global(ol) {
			list-style-type: decimal;
			margin-inline-start: var(--size-5);
		}

		& :global(strong) {
			font-weight: var(--font-weight-6);
		}

		& :global(a) {
			color: var(--text-1);
			font-weight: var(--font-weight-5);
			transition: color 150ms ease;
			text-decoration: underline;

			&:hover {
				color: var(--text-3);
			}
		}
	}
</style>
