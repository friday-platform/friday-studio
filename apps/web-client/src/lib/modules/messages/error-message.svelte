<script lang="ts">
import { IconSmall } from "$lib/components/icons/small";
import type { OutputEntry } from "./types";

const { message }: { message: OutputEntry } = $props();
</script>

<article class="error-message">
	<div class="error-container">
		<div class="error-header">
			<IconSmall.Stop />
			<span class="error-title">Error</span>
		</div>
		<div class="error-content">
			<p>
				{message.content}
			</p>
		</div>
	</div>
</article>

<style>
	.error-message {
		display: flex;
		gap: var(--size-6);
		max-inline-size: 100%;
		margin-block: var(--size-3);
	}

	.error-container {
		background: linear-gradient(135deg,
			color-mix(in srgb, var(--color-red-3) 5%, transparent),
			color-mix(in srgb, var(--color-red-3) 2%, transparent)
		);
		border: 1px solid color-mix(in srgb, var(--color-red-3) 20%, transparent);
		border-radius: var(--radius-3);
		padding: var(--size-3);
		width: 100%;
	}

	.error-header {
		display: flex;
		align-items: center;
		gap: var(--size-2);
		margin-bottom: var(--size-2);
		color: var(--color-red-2);
		font-weight: var(--font-weight-6);
		font-size: var(--font-size-3);
	}

	.error-header :global(svg) {
		width: 16px;
		height: 16px;
		flex-shrink: 0;
	}

	.error-title {
		text-transform: uppercase;
		font-size: var(--font-size-2);
		letter-spacing: 0.05em;
		opacity: 0.9;
	}

	.error-content {
		padding-left: calc(16px + var(--size-2));
	}

	.error-content p {
		color: var(--text-1);
		font-size: var(--font-size-3);
		line-height: var(--font-lineheight-3);
		margin: 0;
		font-weight: var(--font-weight-4);
	}
</style>
