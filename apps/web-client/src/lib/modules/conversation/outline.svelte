<script lang="ts">
import type { AtlasUIMessage } from "@atlas/agent-sdk";

let { messages }: { messages: AtlasUIMessage[] } = $props();
</script>

{#if messages.length > 0}
	<div>
		{#each messages as message}
			{#each message.parts as part}
				{#if part.type === 'data-outline-update'}
					<article>
						<h2>
							{#if part.data.icon}
								<img src={part.data.icon} alt={part.data.title} />
							{/if}

							{part.data.title}
						</h2>

						{#if part.data.artifactId}
							<a href={`#artifact-${part.data.artifactId}`}>{part.data.artifactLabel ?? 'View'}</a>
						{/if}

						{#if part.data.content}
							<p>{part.data.content}</p>
						{/if}
					</article>
				{/if}
			{/each}
		{/each}
	</div>
{/if}

<style>
	div {
		block-size: max-content;
		display: flex;
		flex-direction: column;
		gap: var(--size-6);
		max-block-size: 100%;
		overflow: auto;
		inset-block-start: 0;
		padding-inline-end: var(--size-10);
		position: sticky;
	}

	article {
		h2 {
			color: color-mix(in srgb, var(--color-text) 90%, transparent);
			display: flex;
			align-items: center;
			gap: var(--size-1);
			font-size: var(--font-size-3);
			font-weight: var(--font-weight-5);
			line-height: var(--font-lineheight-0);
			margin-block-end: var(--size-0-5);

			img {
				block-size: var(--size-4);
				inline-size: var(--size-4);
				object-fit: contain;
			}
		}

		a {
			color: var(--color-yellow-2);
			font-size: var(--font-size-2);
			font-weight: var(--font-weight-5);
			text-underline-offset: var(--size-0-5);

			&:hover {
				text-decoration-line: underline;
			}
		}

		p {
			color: color-mix(in srgb, var(--color-text) 60%, transparent);
			font-size: var(--font-size-2);
			font-weight: var(--font-weight-4-5);
			line-height: var(--font-lineheight-3);
			text-wrap-style: balance;
		}
	}
</style>
