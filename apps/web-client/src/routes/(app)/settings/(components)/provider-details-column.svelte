<script lang="ts">
  import { formatFullDate } from "$lib/utils/date";

  type Props = { name: string; label?: string; displayName?: string | null; date: string };

  let { name, label, displayName, date }: Props = $props();

  // Display custom name if set, otherwise fall back to label
  const displayLabel = $derived(displayName ?? label);
</script>

<div>
  <span>
    <span class="provider">{name} •</span>
    {#if displayLabel}<span class="account">{displayLabel}</span>{/if}
  </span>
  <time datetime={date}>{formatFullDate(date)}</time>
</div>

<style>
  div {
    display: flex;
    flex-direction: column;
  }

  .provider {
    font-weight: var(--font-weight-5);
    padding-inline-end: var(--size-1);
  }

  .account,
  time {
    opacity: 0.6;
  }

  time {
    font-size: var(--font-size-2);
  }
</style>
