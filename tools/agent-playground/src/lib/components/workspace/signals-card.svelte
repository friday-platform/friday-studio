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
  <div class="section-header">
    <h2 class="section-label">Signals</h2>
    <p class="section-lede">Define when and why your jobs run.</p>
  </div>

  <div class="rows">
    {#each signals as signal (signal.id)}
      <SignalRow {signal} {workspaceId} {agentIds} />
    {/each}
  </div>
</div>

<style>
  .card {
    background: var(--color-surface-1);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-3);
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
    padding: var(--size-4) var(--size-5);
  }

  .section-header {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  .section-label {
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-5);
    margin: 0;
  }

  .section-lede {
    color: color-mix(in srgb, var(--color-text), transparent 55%);
    font-size: var(--font-size-1);
    margin: 0;
  }

  .rows {
    display: flex;
    flex-direction: column;
  }
</style>
