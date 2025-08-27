<script lang="ts">
import type { OutputEntry } from "$lib/modules/messages/types";

let time = $state(0);

const { actions }: { actions: OutputEntry[] } = $props();

$effect(() => {
  let interval: ReturnType<typeof setInterval> | null = null;

  interval = setInterval(() => {
    time += 1;
  }, 1000);

  return () => {
    if (interval) {
      clearInterval(interval);
    }
  };
});
</script>

<div class="container">
	<div class="progress">Thinking {time}s...</div>

	{#each actions as action}
		{#if action.type === 'thinking'}
			<div class="action">Reasoning</div>
		{:else}
			<div class="action">{action.type}</div>
		{/if}
	{/each}
</div>

<style>
	.container {
		display: flex;
		flex-direction: column;
		gap: var(--size-1);
	}

	.progress {
		align-items: center;
		background: var(--gradient-black-2);
		block-size: var(--size-8);
		border-radius: var(--radius-round);
		color: var(--text-1);
		display: flex;
		font-weight: var(--font-weight-5);
		inline-size: max-content;
		justify-content: center;
		padding-inline: var(--size-3);
	}

	.action {
		align-items: center;
		border: 1px solid var(--border-2);
		block-size: var(--size-8);
		border-radius: var(--radius-round);
		color: var(--text-1);
		display: flex;
		font-weight: var(--font-weight-5);
		inline-size: max-content;
		justify-content: center;
		padding-inline: var(--size-3);
	}
</style>
