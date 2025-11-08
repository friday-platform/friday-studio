<script lang="ts">
interface Props {
  status: "completed" | "error" | "partial" | "pending" | "in-progress";
}

let { status }: Props = $props();
</script>

<span
	class="event-icon"
	class:completed={status === 'completed'}
	class:error={status === 'error'}
	class:partial={status === 'partial'}
	class:pending={status === 'pending'}
	class:in-progress={status === 'in-progress'}
>
	{#if status === 'completed'}
		✓
	{:else if status === 'error'}
		⚠
	{:else if status === 'partial'}
		⚠
	{:else if status === 'in-progress'}
		⟳
	{:else}
		○
	{/if}
</span>

<style>
	.event-icon {
		align-items: center;
		block-size: var(--size-4);
		color: var(--text-3);
		display: inline-flex;
		font-size: var(--font-size-2);
		inline-size: var(--size-4);
		justify-content: center;
	}

	.event-icon.completed {
		color: var(--color-green-3);
	}

	.event-icon.error {
		color: var(--color-red-3);
	}

	.event-icon.partial {
		color: var(--color-yellow-3);
	}

	.event-icon.in-progress {
		color: var(--color-blue-3);
	}

	.event-icon.pending {
		color: var(--text-4);
	}
</style>
