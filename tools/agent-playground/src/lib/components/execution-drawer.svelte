<script lang="ts">
  /**
   * Execution drawer shell with run controls and stepper.
   *
   * Slides in from the right via CSS grid column transition. Three-zone layout:
   * Zone 1 (run controls + stepper, pinned top), Zone 2 (scrollable middle),
   * Zone 3 (pinned bottom). Reads/writes execution state via `useExecutionState()`.
   *
   * @component
   */

  import { Button } from "@atlas/ui";
  import { getClient } from "$lib/client.ts";
  import { useExecutionState } from "$lib/execution-context.svelte.ts";
  import type { Snippet } from "svelte";

  type ExecutionMode = "mock" | "real";

  type Props = {
    /** Run slug for executing an already-loaded workspace (skips generation). */
    runSlug?: string | null;
    /** Slot for extra header content below stepper (results bar). */
    headerExtra?: Snippet;
    /** Slot for scrollable middle content (Zone 2). */
    children?: Snippet;
    /** Slot for pinned bottom summary (Zone 3). */
    footer?: Snippet;
  };

  let { runSlug = null, headerExtra, children, footer }: Props = $props();

  const execution = useExecutionState();
  let executionMode = $state<ExecutionMode>("mock");
  let executionInput = $state("");

  const canRun = $derived(!execution.isRunning);

  /** Auto-advance play mode state. */
  let playing = $state(false);
  let playTimer = $state<ReturnType<typeof setInterval> | null>(null);

  const canPrev = $derived(execution.stepIndex > -1);
  const canNext = $derived(execution.stepIndex < execution.transitions.length - 1);
  const totalSteps = $derived(execution.transitions.length);

  /** Current state name for display. */
  const currentStateName = $derived.by(() => {
    if (totalSteps === 0) return null;
    if (execution.stepIndex < 0) return null;
    return execution.activeState;
  });

  function prev() {
    stopPlaying();
    execution.stepPrev();
  }

  function next() {
    stopPlaying();
    execution.stepNext();
  }

  function reset() {
    stopPlaying();
    execution.stepReset();
  }

  function togglePlay() {
    if (playing) {
      stopPlaying();
    } else {
      startPlaying();
    }
  }

  function startPlaying() {
    if (!canNext) return;
    playing = true;
    playTimer = setInterval(() => {
      if (execution.stepIndex < execution.transitions.length - 1) {
        execution.stepNext();
      } else {
        stopPlaying();
      }
    }, 800);
  }

  function stopPlaying() {
    playing = false;
    if (playTimer !== null) {
      clearInterval(playTimer);
      playTimer = null;
    }
  }

  /** Trigger workspace execution via the ExecutionState context. */
  function run() {
    if (!canRun) return;

    const input = executionInput.trim() || undefined;

    if (runSlug) {
      execution.execute(
        () =>
          getClient().api.workspace.runs[":slug"].execute.$post({
            param: { slug: runSlug },
            json: { real: executionMode === "real", input },
          }) as Promise<Response>,
      );
      return;
    }

    execution.execute(
      () =>
        getClient().api.workspace.execute.$post({
          json: { prompt: "", real: executionMode === "real", input },
        }) as Promise<Response>,
    );
  }

  /** Handle Cmd/Ctrl+Enter keyboard shortcut for run. */
  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canRun) {
      e.preventDefault();
      run();
    }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div class="drawer" tabindex="0" onkeydown={handleKeydown}>
  <!-- Zone 1: Run controls + Stepper (pinned top) -->
  <div class="drawer-header">
    <div class="drawer-title-row">
      <span class="drawer-title">Execution</span>
      <div class="run-controls">
        <div class="mode-toggle">
          <button
            class="mode-option"
            class:active={executionMode === "mock"}
            onclick={() => {
              executionMode = "mock";
            }}
            disabled={execution.isRunning}
          >
            Mock
          </button>
          <button
            class="mode-option"
            class:active={executionMode === "real"}
            onclick={() => {
              executionMode = "real";
            }}
            disabled={execution.isRunning}
          >
            Real
          </button>
        </div>
        {#if execution.isRunning}
          <Button variant="secondary" size="small" onclick={() => execution.cancel()}>Stop</Button>
        {:else}
          <Button variant="primary" size="small" disabled={!canRun} onclick={run}>Run</Button>
        {/if}
      </div>
    </div>

    <textarea
      class="execution-input"
      bind:value={executionInput}
      placeholder="Input for execution (optional)..."
      rows="2"
      disabled={execution.isRunning}
    ></textarea>

    {#if totalSteps > 0}
      <div class="stepper">
        <div class="stepper-controls">
          <Button variant="secondary" size="small" disabled={!canPrev || playing} onclick={prev}>
            Prev
          </Button>
          <Button
            variant="secondary"
            size="small"
            onclick={togglePlay}
            disabled={!canNext && !playing}
          >
            {playing ? "Pause" : "Play"}
          </Button>
          <Button variant="secondary" size="small" disabled={!canNext || playing} onclick={next}>
            Next
          </Button>
          <Button
            variant="secondary"
            size="small"
            disabled={execution.stepIndex === -1}
            onclick={reset}
          >
            Reset
          </Button>
        </div>

        <div class="step-info">
          <span class="step-counter">
            {execution.stepIndex + 1} / {totalSteps}
          </span>
          {#if currentStateName}
            <span class="step-state">{currentStateName}</span>
          {:else}
            <span class="step-state muted">Initial</span>
          {/if}
        </div>
      </div>
    {/if}

    {#if headerExtra}
      {@render headerExtra()}
    {/if}
  </div>

  <!-- Zone 2: Scrollable content (middle) -->
  <div class="drawer-content">
    {#if children}
      {@render children()}
    {:else if execution.isRunning}
      <div class="drawer-empty">Executing...</div>
    {:else if execution.isComplete && totalSteps === 0}
      <div class="drawer-empty">No state transitions recorded.</div>
    {:else if execution.status === "error"}
      <div class="drawer-error">{execution.error ?? "Execution failed"}</div>
    {:else}
      <div class="drawer-empty">Waiting for execution.</div>
    {/if}
  </div>

  <!-- Zone 3: Summary (pinned bottom) -->
  {#if footer}
    <div class="drawer-footer">
      {@render footer()}
    </div>
  {/if}
</div>

<style>
  .drawer {
    block-size: 100%;
    border-inline-start: 1px solid var(--color-border-1);
    display: flex;
    flex-direction: column;
    min-inline-size: 0;
    outline: none;
    overflow: hidden;
  }

  /* Zone 1: Pinned header */
  .drawer-header {
    border-block-end: 1px solid var(--color-border-1);
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    gap: var(--size-3);
    padding: var(--size-3) var(--size-4);
  }

  .drawer-title-row {
    align-items: center;
    display: flex;
    justify-content: space-between;
  }

  .drawer-title {
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-6);
    letter-spacing: var(--font-letterspacing-2);
    text-transform: uppercase;
  }

  .run-controls {
    align-items: center;
    display: flex;
    gap: var(--size-2);
  }

  .mode-toggle {
    display: flex;
    gap: var(--size-1);
  }

  .mode-option {
    background: none;
    block-size: var(--size-5);
    border: 1px solid transparent;
    border-radius: var(--radius-2);
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    cursor: pointer;
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    padding-inline: var(--size-1-5);
    transition: all 150ms ease;
  }

  .mode-option:hover:not(.active):not(:disabled) {
    border-color: var(--color-border-1);
  }

  .mode-option.active {
    border-color: var(--color-border-1);
    color: var(--color-text);
  }

  .mode-option:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  .execution-input {
    background-color: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    color: var(--color-text);
    font-family: var(--font-family-sans);
    font-size: var(--font-size-2);
    inline-size: 100%;
    line-height: var(--font-lineheight-3);
    padding: var(--size-2);
    resize: vertical;
  }

  .execution-input::placeholder {
    color: color-mix(in srgb, var(--color-text), transparent 60%);
  }

  .execution-input:focus {
    border-color: color-mix(in srgb, var(--color-text), transparent 60%);
    outline: none;
  }

  .execution-input:disabled {
    opacity: 0.5;
  }

  .stepper {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .stepper-controls {
    display: flex;
    gap: var(--size-1);
  }

  .step-info {
    align-items: center;
    display: flex;
    gap: var(--size-2);
  }

  .step-counter {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-1);
    font-variant-numeric: tabular-nums;
    min-inline-size: 4ch;
  }

  .step-state {
    color: var(--color-text);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .step-state.muted {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
  }

  /* Zone 2: Scrollable content */
  .drawer-content {
    flex: 1;
    min-block-size: 0;
    overflow-y: auto;
    padding: var(--size-4);
  }

  .drawer-empty {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-2);
  }

  .drawer-error {
    color: var(--color-error);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-1);
    line-height: var(--font-lineheight-3);
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* Zone 3: Pinned footer */
  .drawer-footer {
    border-block-start: 1px solid var(--color-border-1);
    flex-shrink: 0;
    padding: var(--size-3) var(--size-4);
  }
</style>
