<script lang="ts">
type Props = { job: string; summary: string };

let { job, summary }: Props = $props();
</script>

<div class="component">
	<div class="header">
		<div class="group author">
			{job}
		</div>
	</div>

	<div class="details">
		<span class="message">{summary}</span>
	</div>
</div>

<style>
	.component {
		overflow: hidden;
	}

	.header {
		align-items: center;
		display: flex;
		font-weight: var(--font-weight-5);
		gap: var(--size-2);
		justify-content: start;
		inline-size: 100%;
		overflow: hidden;
	}

	.details {
		align-items: center;
		display: flex;
		font-size: var(--font-size-2);
		font-weight: var(--font-weight-5);
		gap: var(--size-1);
		opacity: 0.7;
		margin-block-start: var(--size-0-5);
	}

	.author {
		flex: none;
	}

	.group {
		align-items: center;
		display: flex;
		gap: var(--size-1);
		justify-content: start;
		overflow: hidden;
		text-overflow: ellipsis;

		& :global(svg) {
			flex: none;
		}
	}

	.message {
		font-weight: var(--font-weight-4);
		max-inline-size: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
	}
</style>
