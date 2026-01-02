<script lang="ts">
import { formatFullDate } from "$lib/utils/date";

type Props = { name: string; date: string };

let { name, date }: Props = $props();
</script>

<div>
	<span>{name}</span>
	<time datetime={date}>{formatFullDate(date)}</time>
</div>

<style>
	div {
		display: flex;
		flex-direction: column;
	}

	span {
		font-weight: var(--font-weight-5);
	}

	time {
		font-size: var(--font-size-2);
		opacity: 0.6;
	}
</style>
