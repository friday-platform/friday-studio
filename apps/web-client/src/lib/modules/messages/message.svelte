<script lang="ts">
import { IconSmall } from "$lib/components/icons/small";
import { markdownToHTML } from "./markdown-utils";
import type { OutputEntry } from "./types";

const { message }: { message: OutputEntry } = $props();

// Convert markdown to HTML
const htmlContent = $derived(message.content ? markdownToHTML(message.content) : "");
</script>

<article class="message" class:user={message.type === 'request'}>
	{#if message.type === 'request'}
		<p class="request">
			<IconSmall.Chat />
			{#if htmlContent}
				{@html htmlContent}
			{:else if message.content}
				{message.content}
			{/if}
		</p>
	{:else}
		<div class="content">
			{#if htmlContent}
				{@html htmlContent}
			{:else if message.content}
				{message.content}
			{/if}
		</div>
	{/if}
</article>

<style>
	.message {
		display: flex;
		gap: var(--size-6);
		inline-size: max-content;
		max-inline-size: 100%;

		&:global(:is(.user):not(:first-of-type)) {
			margin-block-start: var(--size-8);
		}
	}

	.request {
		align-items: start;
		color: var(--text-3);
		display: flex;
		font-size: var(--font-size-3);
		font-weight: var(--font-weight-5);
		gap: var(--size-1);

		& :global(svg) {
			flex: none;
			margin-block-start: var(--size-0-5);
		}
	}

	.content {
		& {
			padding-inline-start: var(--size-1);
		}

		& :global(p),
		& :global(li) {
			color: var(--text-1);
			opacity: 0.8;
			font-size: var(--font-size-4);
			line-height: var(--font-lineheight-3);

			&:global(:has(+ ul, + ol, + p)) {
				margin-block-end: var(--size-3);
			}
		}

		& :global(li li) {
			opacity: 1;
		}

		& :global(p),
		& :global(ul),
		& :global(ol) {
			&:global(:has(+ ul, + ol, + p)) {
				margin-block-end: var(--size-3);
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

		& :global(code) {
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
