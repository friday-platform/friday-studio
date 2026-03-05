<script lang="ts">
  /**
   * Execution drawer content: results bar, action trace, snapshots, summary.
   *
   * Self-contained component that reads ExecutionState context and computes
   * all derived state for the three drawer zones. Renders content through
   * the ExecutionDrawer shell's snippet slots.
   *
   * - Results bar: horizontal pills showing progressive result accumulation
   * - Entry actions: status indicators with type markers for current step
   * - Result snapshots: collapsible JSON sections with NEW badges
   * - Summary: compact status line after execution completes
   *
   * @component
   */
  import { Collapsible, IconSmall } from "@atlas/ui";
  import { useExecutionState, type ActionEntry } from "$lib/execution-context.svelte.ts";
  import ExecutionDrawer from "./execution-drawer.svelte";

  type Props = {
    /** Run slug for executing an already-loaded workspace. */
    runSlug?: string | null;
  };

  let { runSlug = null }: Props = $props();

  const execution = useExecutionState();

  // ---------------------------------------------------------------------------
  // Derived data: report, snapshots, actions
  // ---------------------------------------------------------------------------

  const report = $derived(execution.report);
  const stateOrder = $derived(execution.stateOrder);
  const stepIndex = $derived(execution.stepIndex);

  // ---------------------------------------------------------------------------
  // Results bar: all keys across entire execution
  // ---------------------------------------------------------------------------

  /** Every unique result key across all state snapshots. */
  const allResultKeys = $derived.by(() => {
    const snapshots = execution.resultSnapshots;
    if (Object.keys(snapshots).length === 0) return [];
    const keys = new Set<string>();
    for (const stateSnapshot of Object.values(snapshots)) {
      for (const key of Object.keys(stateSnapshot)) {
        keys.add(key);
      }
    }
    return [...keys];
  });

  /** Snapshot at the current step. */
  const currentSnapshot = $derived.by((): Record<string, Record<string, unknown>> => {
    if (stepIndex < 0 || stateOrder.length === 0) return {};
    const snapshots = execution.resultSnapshots;
    const state = stateOrder[stepIndex];
    return state ? (snapshots[state] ?? {}) : {};
  });

  /** Snapshot at the previous step. */
  const previousSnapshot = $derived.by((): Record<string, Record<string, unknown>> => {
    if (stepIndex <= 0 || stateOrder.length === 0) return {};
    const snapshots = execution.resultSnapshots;
    const prevState = stateOrder[stepIndex - 1];
    return prevState ? (snapshots[prevState] ?? {}) : {};
  });

  /** Keys present in current snapshot. */
  const currentKeys = $derived(new Set(Object.keys(currentSnapshot)));

  /** Keys newly added at this step (in current but not previous). */
  const newKeys = $derived.by(() => {
    const prev = new Set(Object.keys(previousSnapshot));
    return new Set(Object.keys(currentSnapshot).filter((k) => !prev.has(k)));
  });

  type PillStatus = "empty" | "filled" | "just-filled";

  /** Status of each result key pill. */
  const pillStatuses = $derived.by((): Map<string, PillStatus> => {
    const map = new Map<string, PillStatus>();
    for (const key of allResultKeys) {
      if (!currentKeys.has(key)) {
        map.set(key, "empty");
      } else if (newKeys.has(key)) {
        map.set(key, "just-filled");
      } else {
        map.set(key, "filled");
      }
    }
    return map;
  });

  // ---------------------------------------------------------------------------
  // Entry actions for current step
  // ---------------------------------------------------------------------------

  /** Actions belonging to the current step's state. */
  const currentActions = $derived.by((): ActionEntry[] => {
    if (stepIndex < 0) return [];
    const state = stateOrder[stepIndex];
    if (!state) return [];
    return execution.actionTrace.filter((a) => a.state === state);
  });

  /** Action type short label and color (matches diagram: fn=amber, AI=blue, agent=green, emit=gray). */
  function actionTypeInfo(actionType: string): { label: string; color: string } {
    const lower = actionType.toLowerCase();
    if (lower.includes("agent")) return { label: "agent", color: "#22c55e" };
    if (lower.includes("llm") || lower.includes("ai")) return { label: "AI", color: "#3b82f6" };
    if (lower.includes("emit") || lower.includes("signal"))
      return { label: "emit", color: "#6b7280" };
    return { label: "fn", color: "#d97706" };
  }

  /** Status indicator character and color. */
  function statusIndicator(status: ActionEntry["status"]): { icon: string; color: string } {
    switch (status) {
      case "completed":
        return { icon: "\u2713", color: "#22c55e" };
      case "failed":
        return { icon: "\u2717", color: "#ef4444" };
      case "started":
        return { icon: "\u25CB", color: "#9ca3af" };
    }
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------

  const isComplete = $derived(execution.isComplete);
  const passedAssertions = $derived(report?.assertions.filter((a) => a.passed).length ?? 0);
  const totalAssertions = $derived(report?.assertions.length ?? 0);

  /** Format duration in human-readable form. */
  function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }
</script>

<ExecutionDrawer {runSlug}>
  {#snippet headerExtra()}
    {#if allResultKeys.length > 0}
      <div class="results-bar">
        {#each allResultKeys as key (key)}
          {@const status = pillStatuses.get(key) ?? "empty"}
          <span class="result-pill {status}" title={key}>{key}</span>
        {/each}
      </div>
    {/if}
  {/snippet}

  {#if stepIndex >= 0}
    <!-- Entry actions -->
    {#if currentActions.length > 0}
      <section class="zone-section">
        <h3 class="zone-label">Actions</h3>
        <div class="action-list">
          {#each currentActions as action, i (`${action.state}-${action.actionType}-${i}`)}
            {@const typeInfo = actionTypeInfo(action.actionType)}
            {@const indicator = statusIndicator(action.status)}
            <div class="action-row" class:failed={action.status === "failed"}>
              <span class="action-indicator" style:color={indicator.color}>{indicator.icon}</span>
              <span class="action-type-marker" style:background-color={typeInfo.color}>
                {typeInfo.label}
              </span>
              <span class="action-name">{action.actionId ?? action.actionType}</span>
              {#if action.status === "failed" && action.error}
                <div class="action-error">{action.error}</div>
              {/if}
              {#if (action.actionType.toLowerCase().includes("agent") || action.actionType
                  .toLowerCase()
                  .includes("llm") || action.actionType
                  .toLowerCase()
                  .includes("ai")) && action.input?.task}
                <div class="action-task">{action.input.task}</div>
              {/if}
            </div>
          {/each}
        </div>
      </section>
    {/if}

    <!-- Result snapshots -->
    {#if Object.keys(currentSnapshot).length > 0}
      <section class="zone-section">
        <h3 class="zone-label">Results</h3>
        <div class="snapshot-list">
          {#each Object.entries(currentSnapshot) as [key, value] (key)}
            {@const isNew = newKeys.has(key)}
            <div class="snapshot-entry" class:new-entry={isNew}>
              <Collapsible.Root defaultOpen={isNew}>
                <Collapsible.Trigger size="grow">
                  {#snippet children(open)}
                    <span class="snapshot-header">
                      <span class="snapshot-chevron" class:expanded={open}>
                        <IconSmall.CaretRight />
                      </span>
                      <span class="snapshot-key">{key}</span>
                      {#if isNew}
                        <span class="new-badge">NEW</span>
                      {/if}
                    </span>
                  {/snippet}
                </Collapsible.Trigger>
                <Collapsible.Content>
                  <pre class="snapshot-value">{JSON.stringify(value, null, 2)}</pre>
                </Collapsible.Content>
              </Collapsible.Root>
            </div>
          {/each}
        </div>
      </section>
    {/if}
  {:else if execution.isRunning}
    <div class="zone-empty">Executing...</div>
  {:else if execution.isComplete && stateOrder.length === 0}
    <div class="zone-empty">No state transitions recorded.</div>
  {:else if execution.status === "error"}
    <div class="zone-error">{execution.error ?? "Execution failed"}</div>
  {:else}
    <div class="zone-empty">Step through execution to see details.</div>
  {/if}

  {#snippet footer()}
    {#if isComplete && report}
      <div class="summary">
        <span
          class="summary-indicator"
          class:success={report.success}
          class:failure={!report.success}
        >
          {report.success ? "\u2713" : "\u2717"}
        </span>
        <span class="summary-state">{report.finalState}</span>
        <span class="summary-divider">&middot;</span>
        <span class="summary-duration">{formatDuration(report.durationMs)}</span>
        {#if totalAssertions > 0}
          <span class="summary-divider">&middot;</span>
          <span class="summary-assertions">{passedAssertions}/{totalAssertions} passed</span>
        {/if}
      </div>
    {/if}
  {/snippet}
</ExecutionDrawer>

<style>
  /* Results bar */
  .results-bar {
    display: flex;
    flex-wrap: wrap;
    gap: var(--size-1);
  }

  .result-pill {
    border: 1px solid var(--color-border-2);
    border-radius: var(--radius-round);
    color: color-mix(in srgb, var(--color-text), transparent 60%);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-0);
    max-inline-size: 12ch;
    overflow: hidden;
    padding-block: var(--size-0-5);
    padding-inline: var(--size-1-5);
    text-overflow: ellipsis;
    transition: all 200ms ease;
    white-space: nowrap;
  }

  .result-pill.filled {
    background-color: color-mix(in srgb, #22c55e, transparent 88%);
    border-color: color-mix(in srgb, #22c55e, transparent 60%);
    color: color-mix(in srgb, var(--color-text), transparent 20%);
  }

  .result-pill.just-filled {
    animation: pill-pop 300ms ease-out;
    background-color: color-mix(in srgb, #22c55e, transparent 75%);
    border-color: color-mix(in srgb, #22c55e, transparent 40%);
    color: var(--color-text);
    font-weight: var(--font-weight-6);
  }

  @keyframes pill-pop {
    0% {
      transform: scale(1);
    }
    50% {
      transform: scale(1.15);
    }
    100% {
      transform: scale(1);
    }
  }

  /* Zone sections */
  .zone-section {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .zone-section + .zone-section {
    margin-block-start: var(--size-4);
  }

  .zone-label {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    letter-spacing: var(--font-letterspacing-2);
    text-transform: uppercase;
  }

  .zone-empty {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-2);
  }

  .zone-error {
    color: var(--color-error);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-1);
    line-height: var(--font-lineheight-3);
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* Entry actions */
  .action-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  .action-row {
    align-items: flex-start;
    display: flex;
    flex-wrap: wrap;
    font-size: var(--font-size-1);
    gap: var(--size-1-5);
    padding: var(--size-1-5) var(--size-2);
  }

  .action-row.failed {
    background-color: color-mix(in srgb, #ef4444, transparent 95%);
    border-radius: var(--radius-1);
  }

  .action-indicator {
    flex-shrink: 0;
    font-size: var(--font-size-2);
    line-height: 1;
  }

  .action-type-marker {
    border-radius: var(--radius-1);
    color: #fff;
    flex-shrink: 0;
    font-size: var(--font-size-0);
    font-weight: var(--font-weight-6);
    letter-spacing: var(--font-letterspacing-1);
    padding-block: 1px;
    padding-inline: var(--size-1);
    text-transform: uppercase;
  }

  .action-name {
    color: var(--color-text);
    font-family: var(--font-family-monospace);
  }

  .action-error {
    color: var(--color-error);
    flex-basis: 100%;
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-0);
    line-height: var(--font-lineheight-3);
    padding-inline-start: calc(var(--size-2) + var(--size-1-5) + var(--font-size-2));
    white-space: pre-wrap;
    word-break: break-word;
  }

  .action-task {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    flex-basis: 100%;
    font-size: var(--font-size-1);
    line-height: var(--font-lineheight-3);
    padding-inline-start: calc(var(--size-2) + var(--size-1-5) + var(--font-size-2));
  }

  /* Result snapshots */
  .snapshot-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  .snapshot-entry {
    border: 1px solid var(--color-border-2);
    border-radius: var(--radius-1);
    overflow: hidden;
  }

  .snapshot-entry.new-entry {
    border-inline-start: 3px solid #f59e0b;
  }

  .snapshot-entry :global(button) {
    padding-block: var(--size-1-5);
    padding-inline: var(--size-2);
    transition: background-color 0.1s;
  }

  .snapshot-entry :global(button:hover) {
    background-color: var(--color-highlight-1);
  }

  .snapshot-header {
    align-items: center;
    display: flex;
    font-size: var(--font-size-1);
    gap: var(--size-1-5);
    inline-size: 100%;
    text-align: start;
  }

  .snapshot-chevron {
    align-items: center;
    color: color-mix(in srgb, var(--color-text), transparent 60%);
    display: inline-flex;
    transition: transform 0.15s ease;
  }

  .snapshot-chevron :global(svg) {
    block-size: 12px;
    inline-size: 12px;
  }

  .snapshot-chevron.expanded {
    transform: rotate(90deg);
  }

  .snapshot-key {
    color: var(--color-text);
    font-family: var(--font-family-monospace);
    font-weight: var(--font-weight-5);
  }

  .new-badge {
    background-color: color-mix(in srgb, #f59e0b, transparent 80%);
    border-radius: var(--radius-1);
    color: #f59e0b;
    font-size: var(--font-size-0);
    font-weight: var(--font-weight-6);
    letter-spacing: var(--font-letterspacing-2);
    padding-block: var(--size-0-5);
    padding-inline: var(--size-1);
  }

  .snapshot-value {
    border-block-start: 1px solid var(--color-border-2);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-1);
    line-height: var(--font-lineheight-3);
    max-block-size: 200px;
    overflow-y: auto;
    padding: var(--size-2) var(--size-3);
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* Summary */
  .summary {
    align-items: center;
    display: flex;
    font-size: var(--font-size-1);
    gap: var(--size-2);
  }

  .summary-indicator {
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-6);
    line-height: 1;
  }

  .summary-indicator.success {
    color: #22c55e;
  }

  .summary-indicator.failure {
    color: #ef4444;
  }

  .summary-state {
    color: var(--color-text);
    font-family: var(--font-family-monospace);
    font-weight: var(--font-weight-5);
  }

  .summary-divider {
    color: color-mix(in srgb, var(--color-text), transparent 60%);
  }

  .summary-duration {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-variant-numeric: tabular-nums;
  }

  .summary-assertions {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
  }
</style>
