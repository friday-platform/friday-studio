<script lang="ts">
import { markdownToHTML } from "./markdown-utils";
import type { OutputEntry } from "./types";
import MessageWrapper from "./wrapper.svelte";

const { message }: { message: OutputEntry } = $props();

// Convert markdown to HTML
const htmlContent = $derived(message.content ? markdownToHTML(message.content) : "");
</script>

<MessageWrapper>
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
</MessageWrapper>

<style>
	.message {
		display: flex;
		gap: var(--size-6);
		overflow: hidden;
	}

	.content {
		& :global(p),
		& :global(li) {
			color: color-mix(in srgb, var(--color-text) 80%, transparent 20%);
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
		}

		& :global(ul) {
			list-style-type: '⋅ ';
			margin-inline-start: var(--size-4);
		}

		& :global(ol) {
			list-style-type: decimal;
			margin-inline-start: var(--size-6);
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
			border-radius: var(--radius-2);
			margin-block: var(--size-2);
			inline-size: max-content;
			max-inline-size: 100%;
			padding-block: var(--size-2);
			padding-inline: var(--size-3);
		}
	}

	.request {
		background-color: var(--color-surface-2);
		border-radius: var(--radius-3);
		padding-block: var(--size-2);
		padding-inline: var(--size-3);
		inline-size: fit-content;
		margin-inline-start: auto;
		margin-inline-end: unset;
		max-inline-size: 90%;
		overflow: hidden;

		.content {
			& :global(p),
			& :global(li) {
				font-weight: var(--font-weight-4);
				line-height: var(--font-lineheight-2);
				opacity: 1;
				font-size: var(--font-size-4);
				word-break: break-word;
			}
		}
	}
</style>
