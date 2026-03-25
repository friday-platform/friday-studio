<!--
  Inline run card for the inspector no-session view. Renders signal form
  fields and a Run button in a card below the pipeline DAG — the primary
  interaction point for starting a job run.

  Styled to match the workspace picker card (inspector-workspace-picker.svelte).

  @component
  @param {SignalDetail[]} signals - Available trigger signals
  @param {string | undefined} jobTitle - Display title for the selected job
  @param {string | undefined} jobDescription - Job description text
  @param {boolean} isExecuting - When true, shows Stop instead of Run
  @param {(signalId: string, payload: Record<string, unknown>, skipStates: string[]) => void} onrun
  @param {() => void} onstop
  @param {Set<string>} disabledSteps - Step IDs currently disabled in the DAG
  @param {(stateId: string) => void} ontogglestep - Re-enable a disabled step
-->
<script lang="ts">
  import type { SignalDetail } from "@atlas/config/signal-details";
  import { humanizeStepName } from "@atlas/config/pipeline-utils";
  import { Button } from "@atlas/ui";
  import SignalInputForm from "$lib/components/signal-input-form.svelte";
  import { z } from "zod";

  interface Props {
    signals: SignalDetail[];
    jobTitle?: string;
    jobDescription?: string;
    isExecuting: boolean;
    onrun: (signalId: string, payload: Record<string, unknown>, skipStates: string[]) => void;
    onstop: () => void;
    disabledSteps: Set<string>;
    ontogglestep: (stateId: string) => void;
  }

  const {
    signals,
    jobTitle,
    jobDescription,
    isExecuting,
    onrun,
    onstop,
    disabledSteps,
    ontogglestep,
  }: Props = $props();

  let selectedSignalId = $state<string | null>(null);
  let payload = $state<Record<string, unknown>>({});

  /** Auto-select first signal when list changes. */
  $effect(() => {
    if (signals.length === 0) {
      selectedSignalId = null;
      return;
    }
    const valid = signals.some((s) => s.name === selectedSignalId);
    if (!valid) {
      selectedSignalId = signals[0]?.name ?? null;
    }
  });

  const activeSignal = $derived(signals.find((s) => s.name === selectedSignalId) ?? null);
  const JsonSchemaShape = z.record(z.string(), z.unknown());

  const schema = $derived.by((): Record<string, unknown> | null => {
    const raw = activeSignal?.schema;
    if (!raw) return null;
    const parsed = JsonSchemaShape.safeParse(raw);
    return parsed.success ? parsed.data : null;
  });

  function handleSignalChange(e: Event) {
    if (!(e.target instanceof HTMLSelectElement)) return;
    selectedSignalId = e.target.value;
    payload = {};
  }

  function handleSubmit() {
    if (!selectedSignalId) return;
    onrun(selectedSignalId, payload, [...disabledSteps]);
  }
</script>

<div class="run-card">
  <div class="run-card-header">
    <h3 class="run-card-title">{jobTitle ?? "Run Job"}</h3>
    {#if jobDescription}
      <p class="run-card-description">{jobDescription}</p>
    {/if}
  </div>

  <form
    class="run-card-body"
    onsubmit={(e) => {
      e.preventDefault();
      handleSubmit();
    }}
  >
    {#if signals.length > 1}
      <fieldset class="field">
        <legend class="legend">Signal</legend>
        <select
          class="signal-select"
          value={selectedSignalId ?? ""}
          onchange={handleSignalChange}
        >
          {#each signals as signal (signal.name)}
            <option value={signal.name}>{signal.title ?? signal.name}</option>
          {/each}
        </select>
      </fieldset>
    {/if}

    {#if schema}
      <SignalInputForm
        {schema}
        values={payload}
        onChange={(v) => { payload = v; }}
      />
    {/if}

    {#if disabledSteps.size > 0}
      <div class="disabled-steps-info">
        <span class="disabled-steps-label">These steps will be skipped during this run:</span>
        <div class="disabled-chips">
          {#each [...disabledSteps] as stateId (stateId)}
            <button
              type="button"
              class="disabled-chip"
              onclick={() => ontogglestep(stateId)}
              title="Click to re-enable"
            >
              ⊘ {humanizeStepName(stateId)}
            </button>
          {/each}
        </div>
      </div>
    {/if}

    <div class="run-card-actions">
      {#if isExecuting}
        <Button variant="secondary" onclick={onstop}>Stop</Button>
      {:else}
        <Button variant="primary" type="submit" disabled={!selectedSignalId || signals.length === 0}>
          Run
        </Button>
      {/if}
    </div>
  </form>
</div>

<style>
  /* Card chrome — matches inspector-workspace-picker.svelte */
  .run-card {
    background: var(--color-surface-1);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-4);
    display: flex;
    flex-direction: column;
    inline-size: 100%;
    max-inline-size: 520px;
  }

  .run-card-header {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
    padding: var(--size-5) var(--size-6) var(--size-3);
  }

  .run-card-title {
    font-size: var(--font-size-4);
    font-weight: var(--font-weight-6);
    color: var(--color-text);
    margin: 0;
  }

  .run-card-description {
    color: color-mix(in srgb, var(--color-text), transparent 20%);
    font-size: var(--font-size-2);
    line-height: 1.5;
    margin: 0;
  }

  .run-card-body {
    display: flex;
    flex-direction: column;
    gap: var(--size-4);
    padding: var(--size-3) var(--size-6) var(--size-5);
  }

  /* ---- Signal selector ---- */

  .field {
    border: none;
    display: flex;
    flex-direction: column;
    gap: var(--size-1-5);
    padding: 0;
    text-align: start;
  }

  .legend {
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    opacity: 0.7;
  }

  .signal-select {
    appearance: none;
    background-color: var(--color-surface-2);
    block-size: var(--size-9);
    border: var(--size-px) solid var(--color-border-1);
    border-radius: var(--radius-3);
    color: var(--color-text);
    font-size: var(--font-size-3);
    padding-inline: var(--size-3);
    transition: all 200ms ease;
  }

  .signal-select:focus {
    border-color: var(--color-text);
    outline: none;
  }

  /* ---- Disabled steps ---- */

  .disabled-steps-info {
    display: flex;
    flex-direction: column;
    gap: var(--size-1-5);
    padding: var(--size-2-5);
    background: color-mix(in srgb, var(--color-warning, #f59e0b), transparent 92%);
    border: var(--size-px) solid color-mix(in srgb, var(--color-warning, #f59e0b), transparent 75%);
    border-radius: var(--radius-3);
  }

  .disabled-steps-label {
    font-size: var(--font-size-1);
    color: color-mix(in srgb, var(--color-text), transparent 30%);
  }

  .disabled-chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--size-1);
  }

  .disabled-chip {
    appearance: none;
    background: color-mix(in srgb, var(--color-text), transparent 90%);
    border: var(--size-px) solid color-mix(in srgb, var(--color-text), transparent 80%);
    border-radius: var(--radius-2);
    color: color-mix(in srgb, var(--color-text), transparent 20%);
    cursor: pointer;
    font-family: var(--font-mono);
    font-size: var(--font-size-1);
    padding: var(--size-0-5) var(--size-2);
    transition: background-color 150ms ease, border-color 150ms ease;
  }

  .disabled-chip:hover {
    background: color-mix(in srgb, var(--color-text), transparent 85%);
    border-color: color-mix(in srgb, var(--color-text), transparent 70%);
  }

  /* ---- Action buttons ---- */

  .run-card-actions {
    padding-block-start: var(--size-1);
  }

  @media (prefers-reduced-motion: reduce) {
    .signal-select,
    .disabled-chip {
      transition: none;
    }
  }
</style>
