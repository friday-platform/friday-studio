<script lang="ts">
  import Button from "$lib/components/button.svelte";

  let {
    connected,
    onclick,
    disabledReason,
  }: { connected: boolean; onclick: () => void; disabledReason?: string } = $props();
</script>

{#if disabledReason}
  <div class="disabled-connect">
    <Button size="small" variant="secondary" disabled>Connect</Button>
    <span class="hint">{disabledReason}</span>
  </div>
{:else}
  <Button size="small" variant="secondary" {onclick}>
    {connected ? "Replace" : "Connect"}
  </Button>
{/if}

<style>
  .disabled-connect {
    align-items: center;
    display: flex;
    gap: var(--size-2);
  }

  .hint {
    color: var(--color-text-secondary);
    font-size: var(--font-size-1);
    opacity: 0.7;
  }
</style>
