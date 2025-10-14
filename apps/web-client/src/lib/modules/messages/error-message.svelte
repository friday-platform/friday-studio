<script lang="ts">
import type { OutputEntry } from "./types";
import MessageWrapper from "./wrapper.svelte";

const { message }: { message: OutputEntry } = $props();
</script>

<MessageWrapper>
	<article class="message">
		<div class="error-box">
			<div class="icon">
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none">
					<path
						d="M12 9V13M12 17H12.01M12 3L2 20H22L12 3Z"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
					/>
				</svg>
			</div>
			<div class="content">
				<p>
					{message.content}
				</p>
			</div>
		</div>
	</article>
</MessageWrapper>

<style>
	.message {
		display: flex;
		max-inline-size: 100%;
	}

	.error-box {
		display: flex;
		gap: var(--size-3);
		align-items: flex-start;
		background: color-mix(in srgb, var(--color-red) 8%, var(--color-surface-1));
		border: 1px solid color-mix(in srgb, var(--color-red) 25%, transparent);
		border-radius: var(--radius-3);
		padding: var(--size-3) var(--size-4);
		max-inline-size: 100%;
	}

	.icon {
		color: var(--color-red);
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		margin-block-start: var(--size-0-5);
	}

	.content {
		flex: 1;
		min-inline-size: 0;

		p {
			color: var(--color-text-1);
			font-size: var(--font-size-2);
			line-height: var(--font-lineheight-3);
			margin: 0;
			word-break: break-word;
		}
	}
</style>
