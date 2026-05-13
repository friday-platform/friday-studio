<script lang="ts">
  import { Button } from "@atlas/ui";
  import { browser } from "$app/environment";
  import { checkDaemonHealth, daemonHealth } from "$lib/daemon-health.svelte";
  import { fade } from "svelte/transition";
  import type { Snippet } from "svelte";
  import DaemonLoading from "./daemon-loading.svelte";

  const { children }: { children: Snippet } = $props();

  function retry() {
    checkDaemonHealth();
  }
</script>

<!--
  The `browser &&` guards let the export preview route (csr=false) render
  children during SSR. Without them, `daemonHealth.loading` starts true and
  only flips on a client-side fetch, leaving SSR stuck on "Connecting…".
-->
{#if browser && daemonHealth.loading && !daemonHealth.hasConnected}
  <div class="gate-state" out:fade={{ duration: 400 }}>
    <DaemonLoading />
  </div>
{:else if browser && !daemonHealth.connected && !daemonHealth.hasConnected}
  <div class="gate-state" out:fade={{ duration: 400 }}>
    <DaemonLoading />
    <Button size="small" variant="secondary" onclick={retry}>Retry Now</Button>
  </div>
{:else}
  <div class="gate-content" in:fade={{ duration: 400 }}>
    {#if !daemonHealth.connected}
      <div class="gate-banner" role="status">
        <span>Reconnecting to Friday Studio…</span>
        <Button size="small" variant="secondary" onclick={retry}>Retry Now</Button>
      </div>
    {/if}
    {@render children()}
  </div>
{/if}

<style>
  .gate-state {
    align-items: center;
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
    justify-content: center;
    min-block-size: 100%;
    padding: var(--size-10);
  }

  /* Wrap the content branch in a real box so Svelte's in:fade has
     something to animate; flex column lets children fill the page. */
  .gate-content {
    block-size: 100%;
    display: flex;
    flex-direction: column;
  }

  .gate-banner {
    align-items: center;
    background: color-mix(in srgb, var(--color-warning), transparent 85%);
    border-block-end: 1px solid color-mix(in srgb, var(--color-warning), transparent 60%);
    color: var(--color-text);
    display: flex;
    gap: var(--size-3);
    justify-content: center;
    padding: var(--size-2) var(--size-4);
  }
</style>
