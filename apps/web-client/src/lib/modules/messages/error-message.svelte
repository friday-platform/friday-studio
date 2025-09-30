<script lang="ts">
import type { OutputEntry } from "./types";

const { message }: { message: OutputEntry } = $props();
</script>

<article class="message">
	<div class="content">
		<p>
			{message.content}
		</p>
	</div>
</article>

<style>
	.message {
		display: flex;
		gap: var(--size-6);
		inline-size: max-content;
		max-inline-size: 100%;
	}

	.content {
		& {
			padding-block-start: var(--size-1-5);
		}

		p {
			color: var(--color-red-2);

			font-size: var(--font-size-4);
			line-height: var(--font-lineheight-3);
		}
	}
</style>
