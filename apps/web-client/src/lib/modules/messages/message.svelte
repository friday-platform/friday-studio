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
		<div class="request">
			<div class="content">
				{#if htmlContent}
					{@html htmlContent}
				{:else if message.content}
					{message.content}
				{/if}
			</div>
		</div>
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
		max-inline-size: 100%;
	}

	.content {
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

	.request {
		background-color: var(--color-surface-2);
		border-radius: var(--radius-3);
		padding-block: var(--size-2);
		padding-inline: var(--size-3);
		inline-size: max-content;
		margin-inline-start: auto;
		max-inline-size: 90%;

		.content {
			& :global(p),
			& :global(li) {
				font-weight: var(--font-weight-4-5);
				line-height: var(--font-lineheight-2);
				opacity: 1;
				font-size: var(--font-size-2);
			}

			& :global(p),
			& :global(ul),
			& :global(ol) {
				&:global(:has(+ ul, + ol, + p)) {
					margin-block-end: 0;
				}
			}

			& :global(ul) {
				margin-inline-start: var(--size-3);
			}

			& :global(ol) {
				margin-inline-start: var(--size-5);
			}
		}
	}
</style>
