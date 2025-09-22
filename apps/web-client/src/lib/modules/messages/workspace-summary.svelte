<script lang="ts">
import { CustomIcons } from "$lib/components/icons/custom";
import { IconSmall } from "$lib/components/icons/small";

const {
  data,
  onShowPlan,
}: { onShowPlan: () => void; data: { data: { description: string; agents: string[] } } } = $props();
</script>

{#if data}
	<button type="button" onclick={() => onShowPlan()}>
		<span class="icon">
			<IconSmall.Workspace />
		</span>

		<span class="label">
			Plan Updated
			<span class="arrow">
				<IconSmall.CaretDown />
			</span>
		</span>
	</button>
{/if}

<style>
	button {
		align-items: center;
		border: 1px solid var(--color-border-1);
		border-radius: var(--radius-3);
		display: flex;
		font-size: var(--font-size-1);
		font-weight: var(--font-weight-5);
		inline-size: max-content;
		padding-block: var(--size-2);
		padding-inline: var(--size-3);
		margin-block: var(--size-2);
		gap: var(--size-2);
		transition: all 150ms ease-in-out;

		.icon {
			color: var(--accent-1);
		}

		.label {
			display: flex;
			gap: var(--size-1);
		}

		.arrow {
			opacity: 0.5;
			transform: rotate(-90deg);
		}

		&:hover {
			border-color: var(--highlight-2s);
			background: var(--highlight-2s);
		}
	}
</style>
