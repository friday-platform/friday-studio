<script lang="ts">
import { markdownToHTML } from "$lib/utils/markdown";

const { content }: { content: string } = $props();

// Convert markdown to HTML
const htmlContent = $derived(markdownToHTML(content));
</script>

<div>
	{@html htmlContent}
</div>

<style>
	div {
		& :global(h1),
		& :global(h2),
		& :global(h3),
		& :global(h4),
		& :global(ul),
		& :global(ol),
		& :global(p) {
			color: color-mix(in srgb, var(--color-text) 80%, transparent 20%);
			max-inline-size: 80ch;
		}

		/* HEADING 1 */
		& :global(h1) {
			font-size: var(--font-size-7);
			font-weight: var(--font-weight-6);
			line-height: var(--font-lineheight-1);
		}

		& :global(h1 + h2) {
			margin-block-start: var(--size-6);
		}

		/* HEADING 2 */
		& :global(h2) {
			font-size: var(--font-size-6);
			font-weight: var(--font-weight-6);
			line-height: var(--font-lineheight-1);
		}

		& :global(h2 + p),
		& :global(h2 + ul),
		& :global(h2 + ol) {
			margin-block-start: var(--size-1);
		}

		/* HEADING 3 */
		& :global(h3) {
			font-size: var(--font-size-5);
			font-weight: var(--font-weight-6);
		}

		& :global(h2 + h3),
		& :global(p + h3),
		& :global(ol + h3),
		& :global(ul + h3) {
			margin-block-start: var(--size-4);
		}

		& :global(h3 + p),
		& :global(h3 + ul),
		& :global(h3 + ol) {
			margin-block-start: var(--size-1);
		}

		/* HEADING 4 */
		& :global(h4) {
			font-size: var(--font-size-3);
			font-weight: var(--font-weight-5);
		}

		& :global(p),
		& :global(li) {
			font-size: var(--font-size-5);
			line-height: var(--font-lineheight-3);
			word-break: break-word;
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

			& :global(+ h2) {
				margin-block-start: var(--size-6);
			}
		}

		& :global(ul) {
			list-style-type: '⋅ ';
			list-style-position: inside;
		}

		& :global(ol) {
			list-style-type: decimal;
			list-style-position: inside;
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

		& :global(code),
		& :global(pre) {
			background-color: var(--color-surface-2);
			color: var(--color-red);
			font-family: var(--font-family-monospace);
			font-size: var(--font-size-4);
			font-weight: var(--font-weight-5);
		}

		& :global(p code) {
			border-radius: var(--radius-1);
			display: inline block;
			line-height: var(--font-lineheight-4);
			padding-block: var(--size-0-5);
			padding-inline: var(--size-1);
		}

		& :global(pre) {
			border-radius: var(--radius-3);
			margin-block: var(--size-4);
			inline-size: max-content;
			max-inline-size: calc(100% - var(--size-16));
			margin-inline: var(--size-8);
			padding-block: var(--size-4);
			padding-inline: var(--size-6);
			overflow-x: auto;
		}
	}
</style>
