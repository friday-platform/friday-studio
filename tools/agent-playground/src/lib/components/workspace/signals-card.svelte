<!--
  Dashboard card for workspace signals.

  Shows signal name, type badge, provider-specific config (path/schedule/watch),
  and triggered job names with arrow prefix.

  @component
  @param {Signal[]} signals - Signal entries with provider config details
  @param {string} workspaceId - Current workspace ID
-->

<script lang="ts">
  import SignalRow from "./signal-row.svelte";

  type Signal = {
    id: string;
    name: string;
    type: string;
    description: string;
    linkedJobs: string[];
    endpoint?: string;
    schedule?: string;
    timezone?: string;
    watchPath?: string;
  };

  type Props = { signals: Signal[]; workspaceId: string; agentIds?: string[] };

  let { signals, workspaceId, agentIds = [] }: Props = $props();
</script>

<div class="card">
  <header class="section-head">
    <h2 class="section-title">Signals</h2>
    <span class="section-count">{signals.length}</span>
  </header>

  <div class="rows">
    {#each signals as signal (signal.id)}
      <SignalRow {signal} {workspaceId} {agentIds} />
    {/each}
  </div>
</div>

<style>
  .card {
    background: var(--color-surface-1);
    border-radius: var(--radius-4);
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
    padding: var(--size-4) var(--size-5);
  }

  .section-head {
    align-items: baseline;
    display: flex;
    gap: var(--size-2-5);
  }

  .section-title {
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-6);
    margin: 0;
  }

  .section-count {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-1);
  }

  .rows {
    display: flex;
    flex-direction: column;
  }
</style>
