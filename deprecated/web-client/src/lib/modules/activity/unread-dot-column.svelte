<script lang="ts">
  const SESSION_FRESHNESS_DAYS = 3;
  const RESOURCE_FRESHNESS_DAYS = 7;

  type Props = {
    readStatus: "viewed" | "dismissed" | null;
    type: "session" | "resource";
    createdAt: string;
  };

  let { readStatus, type, createdAt }: Props = $props();

  const isWithinFreshnessWindow = $derived.by(() => {
    const maxDays = type === "session" ? SESSION_FRESHNESS_DAYS : RESOURCE_FRESHNESS_DAYS;
    const ageMs = Date.now() - new Date(createdAt).getTime();
    return ageMs < maxDays * 86400000;
  });

  const showDot = $derived(readStatus !== "dismissed" && isWithinFreshnessWindow);
</script>

{#if showDot}
  <span class="unread-dot"></span>
{/if}

<style>
  .unread-dot {
    background-color: var(--blue-2);
    block-size: var(--size-2);
    border-radius: var(--radius-round);
    inline-size: var(--size-2);
  }
</style>
