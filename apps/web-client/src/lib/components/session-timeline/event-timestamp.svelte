<script lang="ts">
interface Props {
  timestamp: string;
}

let { timestamp }: Props = $props();

const formatted = $derived.by(() => {
  const date = new Date(timestamp);
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
});
</script>

<time class="event-timestamp" datetime={timestamp}>
	{formatted}
</time>

<style>
	.event-timestamp {
		color: var(--text-3);
		font-family: var(--font-family-monospace);
		font-size: var(--font-size-2);
	}
</style>
