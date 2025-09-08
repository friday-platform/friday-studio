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
			<span class="header"><IconSmall.Chat /> You</span>

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
		inline-size: max-content;
		max-inline-size: 100%;

		&:global(:not(:first-of-type)) {
			padding-block-start: var(--size-1-5);
		}

		&:global(:is(.user):not(:first-of-type)) {
			padding-block-start: var(--size-8);
		}
	}

	.request {
		.header {
			align-items: center;
			color: var(--accent-1);
			display: flex;
			font-size: var(--font-size-2);
			font-weight: var(--font-weight-5);
			gap: var(--size-1);

			& :global(svg) {
				flex: none;
				margin-inline-start: calc(var(--size-0-5) * -1);
			}
		}
	}

	.content {
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

	.request .content {
		& {
			padding-block-end: var(--size-1-5);
		}

		& :global(p),
		& :global(li) {
			color: var(--text-3);
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
			margin-inline-start: var(--size-4);
		}
	}
</style>
