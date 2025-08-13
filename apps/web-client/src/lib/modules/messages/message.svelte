<script lang="ts">
	import type { OutputEntry } from './types';
	import { markdownToHTML } from './markdown-utils';

	let { message }: { message: OutputEntry } = $props();

	// Convert markdown to HTML
	const htmlContent = $derived(message.content ? markdownToHTML(message.content) : '');
</script>

{#if message.author}
	<span class="author">{message.author}</span>
{/if}
<div>
	{#if htmlContent}
		{@html htmlContent}
	{:else if message.content}
		{message.content}
	{/if}
</div>

<style>
	.author {
		color: var(--text-1);
		font-size: var(--font-size-5);
		font-weight: var(--font-weight-6);
	}

	div {
		& :global(p),
		& :global(ul),
		& :global(ol) {
			color: var(--text-1);
			opacity: 0.8;
			font-size: var(--font-size-5);
			line-height: var(--font-lineheight-3);
			margin-block-end: var(--size-3);
		}

		& :global(ul) {
			list-style-type: disc;
			margin-inline-start: var(--size-5);
		}

		& :global(ol) {
			list-style-type: decimal;
			margin-inline-start: var(--size-5);
		}

		& :global(strong) {
			font-weight: var(--font-weight-6);
		}

		& :global(code) {
			background-color: #f0f0f0;
		}
	}
</style>
