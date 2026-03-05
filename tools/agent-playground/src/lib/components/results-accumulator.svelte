<script lang="ts">
  /**
   * Results accumulator panel for FSM execution.
   *
   * Displays the `resultSnapshots` from an ExecutionReport at the current
   * stepper position. Keys that were newly added in the current step are
   * highlighted compared to the previous step's snapshot.
   *
   * @component
   * @param {Record<string, Record<string, Record<string, unknown>>>} snapshots - resultSnapshots from ExecutionReport
   * @param {string[]} stateOrder - ordered state names from stateTransitions (to index snapshots)
   * @param {number} stepIndex - current stepper position (-1 = initial, before any transition)
   */

  type ResultSnapshots = Record<string, Record<string, Record<string, unknown>>>;

  type Props = { snapshots: ResultSnapshots; stateOrder: string[]; stepIndex: number };

  let { snapshots, stateOrder, stepIndex }: Props = $props();

  /** Snapshot at the current step. */
  const currentSnapshot = $derived.by(() => {
    if (stepIndex < 0 || stateOrder.length === 0) return {};
    const state = stateOrder[stepIndex];
    return state ? (snapshots[state] ?? {}) : {};
  });

  /** Snapshot at the previous step (for diff highlighting). */
  const previousSnapshot = $derived.by(() => {
    if (stepIndex <= 0 || stateOrder.length === 0) return {};
    const prevState = stateOrder[stepIndex - 1];
    return prevState ? (snapshots[prevState] ?? {}) : {};
  });

  /** Top-level keys that are new in the current snapshot. */
  const newKeys = $derived.by(() => {
    const prev = new Set(Object.keys(previousSnapshot));
    return new Set(Object.keys(currentSnapshot).filter((k) => !prev.has(k)));
  });

  const hasData = $derived(Object.keys(currentSnapshot).length > 0);

  /**
   * Format a result value for display.
   * Truncates long output to keep the panel scannable.
   */
  function formatValue(value: Record<string, unknown>): string {
    return JSON.stringify(value, null, 2);
  }
</script>

<div class="results-panel">
  {#if !hasData}
    <div class="empty">
      {#if stepIndex < 0}
        Step through execution to see results.
      {:else}
        No results at this step.
      {/if}
    </div>
  {:else}
    <div class="results-list">
      {#each Object.entries(currentSnapshot) as [key, value] (key)}
        <div class="result-entry" class:new-key={newKeys.has(key)}>
          <div class="result-key">
            {key}
            {#if newKeys.has(key)}
              <span class="new-badge">new</span>
            {/if}
          </div>
          <pre class="result-value">{formatValue(value)}</pre>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .empty {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-2);
    padding-block: var(--size-4);
  }

  .new-badge {
    background-color: color-mix(in srgb, #22c55e, transparent 80%);
    border-radius: var(--radius-1);
    color: #22c55e;
    font-size: var(--font-size-0);
    font-weight: var(--font-weight-5);
    letter-spacing: var(--font-letterspacing-2);
    padding-block: var(--size-0-5);
    padding-inline: var(--size-1);
    text-transform: uppercase;
  }

  .new-key {
    border-color: color-mix(in srgb, #22c55e, transparent 60%);
  }

  .result-entry {
    border: 1px solid var(--color-border-2);
    border-radius: var(--radius-2);
    overflow: hidden;
  }

  .result-key {
    align-items: center;
    background-color: var(--color-surface-2);
    border-block-end: 1px solid var(--color-border-2);
    color: var(--color-text);
    display: flex;
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    gap: var(--size-2);
    padding-block: var(--size-1-5);
    padding-inline: var(--size-3);
  }

  .result-value {
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-1);
    line-height: var(--font-lineheight-3);
    max-block-size: 200px;
    overflow-y: auto;
    padding: var(--size-3);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .results-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .results-panel {
    display: flex;
    flex-direction: column;
  }
</style>
