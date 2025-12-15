<script lang="ts">
import type { AtlasUIMessagePart } from "@atlas/agent-sdk";
import { SvelteMap } from "svelte/reactivity";
import { IconSmall } from "$lib/components/icons/small";
import { markdownToHTML } from "$lib/utils/markdown";

const { parts }: { parts: AtlasUIMessagePart[] } = $props();

let views = new SvelteMap<number, boolean>();
</script>

<div class="details">
	{#each parts as part, index}
		{#if part.type === 'step-start'}
			<div class="step-start">
				<span class="step-start-text">
					<span aria-hidden="true" class="step-start-indicator"></span>
					Starting step
				</span>
			</div>
		{:else if part.type === 'reasoning'}
			{@const text = markdownToHTML(part.text)}
			<div class="padded">
				<button
					type="button"
					class:open={views.get(index) ?? false}
					onclick={() => {
						const status = views.get(index) ?? false;

						views.set(index, !status);
					}}
				>
					<IconSmall.Workspace /> Reasoning <span class="indicator"><IconSmall.CaretRight /></span>
				</button>

				{#if views.get(index)}
					<div class="reasoning-text">
						{@html text}
					</div>
				{/if}
			</div>
		{:else if part.type === 'tool-display_artifact'}
			<div class="padded">
				<button
					type="button"
					class:open={views.get(index) ?? false}
					onclick={() => {
						const status = views.get(index) ?? false;

						views.set(index, !status);
					}}
				>
					<IconSmall.File /> Displaying Artifact
					<span class="indicator"><IconSmall.CaretRight /></span>
				</button>

				{#if views.get(index)}
					<div class="tool-text">
						<pre>{JSON.stringify(part, null, 2)}</pre>
					</div>
				{/if}
			</div>
		{:else if part.type.startsWith('tool-')}
			<div class="padded">
				<button
					type="button"
					class:open={views.get(index) ?? false}
					onclick={() => {
						const status = views.get(index) ?? false;

						views.set(index, !status);
					}}
				>
					<IconSmall.ToolCall /> Calling tools
					<span class="indicator"><IconSmall.CaretRight /></span>
				</button>

				{#if views.get(index)}
					<div class="tool-text">
						<pre>{JSON.stringify(part, null, 2)}</pre>
					</div>
				{/if}
			</div>
		{:else if part.type === 'text'}
			{@const text = markdownToHTML(part.text)}

			<div class="padded">
				<button
					type="button"
					class:open={views.get(index) ?? false}
					onclick={() => {
						const status = views.get(index) ?? false;

						views.set(index, !status);
					}}
				>
					<IconSmall.Chat /> Outputting text response
					<span class="indicator"><IconSmall.CaretRight /></span>
				</button>

				{#if views.get(index)}
					<div class="reasoning-text">
						{@html text}
					</div>
				{/if}
			</div>
		{/if}
	{/each}
</div>

<style>
	.details {
		border-inline-start: 1.5px solid var(--color-border-1);
		display: flex;
		flex-direction: column;
		margin-inline: var(--size-1);
		padding-inline: var(--size-1);
		margin-block-start: var(--size-3);
		inline-size: calc(100% - var(--size-2));
		max-inline-size: var(--size-160);

		div {
			&.padded {
				padding-inline-start: var(--size-1-5);
			}

			&.step-start {
				margin-inline-start: calc(calc(var(--size-2-5) + var(--size-px)) * -1);
				margin-block-end: var(--size-1);
				padding-inline-start: var(--size-0-5);

				&:not(:first-of-type) {
					margin-block-start: var(--size-1);
				}

				&:first-of-type {
					margin-block-start: calc(-1 * var(--size-1-5));
				}
			}
		}

		button,
		.step-start-text {
			block-size: var(--size-5);
			color: color-mix(in srgb, var(--color-text) 80%, transparent);
			display: flex;
			align-items: center;
			gap: var(--size-1);
			font-size: var(--font-size-2);
			font-weight: var(--font-weight-5);

			& :global(svg) {
				opacity: 0.5;
			}

			.indicator {
				opacity: 0;
				transition: all 150ms ease-in-out;
			}

			&:hover .indicator,
			&.open .indicator {
				opacity: 1;
			}

			&.open .indicator {
				transform: rotate(90deg);
			}
		}

		.step-start-indicator {
			background-color: var(--color-surface-1);
			border: 1.5px solid color-mix(in srgb, var(--color-text) 50%, transparent);
			border-radius: var(--radius-round);
			block-size: var(--size-2);
			inline-size: var(--size-2);
			opacity: 1;
		}

		.reasoning-text {
			padding-inline-start: var(--size-5);
			padding-block-end: var(--size-2);

			& :global(p),
			& :global(li) {
				font-size: var(--font-size-2);
				font-weight: var(--font-weight-4);
				opacity: 0.7;
			}

			& :global(ul) {
				list-style-type: '⋅ ';
				list-style-position: inside;
			}

			& :global(p),
			& :global(ul),
			& :global(ol) {
				&:global(:has(+ ul, + ol, + p)) {
					margin-block-end: var(--size-1-5);
				}
			}
		}

		.tool-text {
			padding-inline-start: var(--size-5);
			padding-block-end: var(--size-2);

			pre {
				background-color: color-mix(in srgb, var(--color-surface-2) 50%, transparent);
				border-radius: var(--radius-2);
				color: color-mix(in srgb, var(--color-text) 80%, transparent);
				padding: var(--size-2);
				font-size: var(--font-size-1);
				font-weight: var(--font-weight-4-5);
				overflow: auto;
				max-inline-size: 100%;
				scrollbar-width: thin;
			}
		}
	}
</style>
