<script lang="ts">
  import { Button } from "@atlas/ui";
  import { checkDaemonHealth, daemonHealth } from "$lib/daemon-health.svelte";
  import type { Snippet } from "svelte";

  const { children }: { children: Snippet } = $props();

  function retry() {
    checkDaemonHealth();
  }
</script>

{#if daemonHealth.loading}
  <div class="gate-state">
    <p class="gate-message">Connecting to daemon...</p>
  </div>
{:else if !daemonHealth.connected}
  <div class="gate-state">
    <p class="gate-icon">!</p>
    <p class="gate-title">Daemon unreachable</p>
    <p class="gate-command">
      Run: <code>deno task atlas daemon start --detached</code>
    </p>
    <Button size="small" variant="secondary" onclick={retry}>Retry Now</Button>
  </div>
{:else}
  {@render children()}
{/if}

<style>
  .gate-state {
    align-items: center;
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--size-3);
    justify-content: center;
    padding: var(--size-10);
  }

  .gate-icon {
    align-items: center;
    background-color: color-mix(in srgb, var(--color-error), transparent 85%);
    block-size: var(--size-12);
    border-radius: var(--radius-round);
    color: var(--color-error);
    display: flex;
    font-size: var(--font-size-6);
    font-weight: var(--font-weight-7);
    inline-size: var(--size-12);
    justify-content: center;
  }

  .gate-title {
    font-size: var(--font-size-5);
    font-weight: var(--font-weight-6);
  }

  .gate-message {
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    font-size: var(--font-size-3);
  }

  .gate-command {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-size: var(--font-size-2);

    code {
      background-color: var(--color-surface-2);
      border-radius: var(--radius-1);
      font-size: var(--font-size-2);
      padding: var(--size-0-5) var(--size-1);
    }
  }
</style>
