<script lang="ts">
import { formatChatDate } from "$lib/utils/date";

type Props = { date: string };

let { date }: Props = $props();
</script>

<div class="component">
	<span class="details">
		<span class="time" title={new Date(date).toLocaleString()}>
			{formatChatDate(date)}
		</span>
	</span>
</div>

<style>
	.component {
		align-items: end;
		block-size: 100%;
		display: flex;
		justify-content: stretch;
		padding-block-end: var(--size-3);
		inline-size: 100%;

		.details {
			align-items: center;
			display: flex;
			justify-content: space-between;
			inline-size: 100%;
			gap: var(--size-2);
		}

		.time {
			flex: 1;
			text-align: center;
		}
	}
</style>
