<script lang="ts">
  import { formatFullDate } from "$lib/utils/date";

  type Props = { name: string; label?: string; date: string };

  let { name, label, date }: Props = $props();
</script>

<div>
  <span>
    <span class="provider">{name} •</span>
    {#if label}<span class="account">{label}</span>{/if}
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
