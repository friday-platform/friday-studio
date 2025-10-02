<script lang="ts">
import type { SlackSummaryData, SummaryData } from "@atlas/core/artifacts";
import { CustomIcons } from "$lib/components/icons/custom";
import { markdownToHTML } from "$lib/modules/messages/markdown-utils";

type Props = { data: SummaryData | SlackSummaryData; source?: "slack" };

let { data, source }: Props = $props();
const htmlContent = $derived(markdownToHTML(data));

let isExpanded = $state(false);
</script>

<div class="component">
	<header>
		<h2>
			{#if source === 'slack'}
				<CustomIcons.Slack />
			{/if}

			<span> Summary </span>
		</h2>

		<button onclick={() => (isExpanded = !isExpanded)}>Expand</button>
	</header>
	<div class="summary" class:expanded={isExpanded}>
		{@html htmlContent}
	</div>
</div>

<style>
	.component {
		border: var(--size-px) solid color-mix(in oklch, var(--color-border-1), transparent 50%);
		border-radius: var(--radius-4);
		flex: none;
		max-inline-size: 80%;
		overflow: hidden;
		position: relative;

		header {
			align-items: center;
			display: flex;
			font-size: var(--font-size-1);
			justify-content: space-between;
			padding-block-start: var(--size-5);
			padding-inline: var(--size-5);
			position: relative;
			z-index: var(--layer-2);

			h2 {
				display: flex;
				align-items: center;
				gap: var(--size-2);

				span {
					font-weight: var(--font-weight-4-5);
					opacity: 0.5;
				}
			}

			button {
				opacity: 0.8;

				&:hover {
					text-decoration: underline;
				}
			}
		}
	}

	.summary {
		& {
			max-block-size: var(--size-24);
			overflow: hidden;
			padding-inline: var(--size-5);
			padding-block: var(--size-2) var(--size-5);
		}

		&:after {
			background: linear-gradient(
				to top,
				var(--color-surface-1) 0%,
				color-mix(in oklch, var(--color-surface-1), transparent 100%)
			);
			content: '';
			position: absolute;
			inset-inline: 0;
			inset-block-end: 0;
			block-size: var(--size-20);
			inline-size: 100%;
			z-index: var(--layer-1);
		}

		&.expanded {
			max-block-size: none;
			overflow: visible;

			&:after {
				display: none;
			}
		}

		& :global(h1) {
			font-size: var(--font-size-4);
			font-weight: var(--font-weight-6);
			line-height: var(--font-lineheight-0);
		}

		& :global(p),
		& :global(li) {
			color: var(--text-1);
			opacity: 0.8;
			font-size: var(--font-size-3);
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
