<!--
  Waterfall timeline component for agent execution visualization.

  Chrome DevTools network panel style: each AgentBlock is a row with an
  agent name label on the left and a horizontal bar showing duration
  relative to session start. Duration labels sit outside the bar.

  @component
  @param {import("@atlas/core/session/session-events").SessionView | null} sessionView
  @param {import("@atlas/core/session/session-events").AgentBlock | null} selectedBlock
  @param {(block: import("@atlas/core/session/session-events").AgentBlock) => void} onselect
-->

<script lang="ts">
  import { humanizeStepName } from "@atlas/config/pipeline-utils";
  import type { AgentBlock, SessionView } from "@atlas/core/session/session-events";
  import { fly } from "svelte/transition";
  import {
    computeBarLayouts,
    computeTotalDurationMs,
    rowStatusClasses,
  } from "./waterfall-layout.ts";

  interface Props {
    sessionView: SessionView | null;
    selectedBlock: AgentBlock | null;
    onselect: (block: AgentBlock) => void;
  }

  const { sessionView, selectedBlock, onselect }: Props = $props();

  const blocks = $derived(sessionView?.agentBlocks ?? []);
  const hasBlocks = $derived(blocks.some((b) => b.status !== "pending"));

  /** Ticking clock for running bar growth. Only ticks while session is active and a block is running. */
  let now = $state(Date.now());
  $effect(() => {
    const terminalStatuses = ["completed", "failed", "skipped"];
    const isTerminal = terminalStatuses.includes(sessionView?.status ?? "");
    if (isTerminal || !blocks.some((b) => b.status === "running")) return;
    const interval = setInterval(() => {
      now = Date.now();
    }, 100);
    return () => clearInterval(interval);
  });

  /**
   * Total session duration for scaling bars. Uses the session's durationMs
   * if complete, otherwise derives from timestamps or sums durations.
   */
  const totalDurationMs = $derived(
    sessionView
      ? computeTotalDurationMs(blocks, sessionView.startedAt, sessionView.durationMs, now)
      : 0,
  );

  /**
   * Human-readable tick intervals. Picks a round step size that
   * produces 3–7 ticks across the timeline.
   */
  const ticks = $derived.by((): { ms: number; pct: number }[] => {
    if (totalDurationMs <= 0) return [];

    const steps = [500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000];
    const idealStep = totalDurationMs / 5;
    let step = steps[steps.length - 1] ?? 600000;
    for (const s of steps) {
      if (s >= idealStep) {
        step = s;
        break;
      }
    }

    const result: { ms: number; pct: number }[] = [];
    let ms = step;
    while (ms < totalDurationMs) {
      result.push({ ms, pct: (ms / totalDurationMs) * 100 });
      ms += step;
    }
    return result;
  });

  /** Format milliseconds for display. */
  function formatMs(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    const mins = Math.floor(ms / 60000);
    const secs = Math.round((ms % 60000) / 1000);
    return `${mins}m${secs > 0 ? ` ${secs}s` : ""}`;
  }

  /** Pre-computed bar left/width percentages for all blocks. */
  const barLayouts = $derived(
    sessionView ? computeBarLayouts(blocks, sessionView.startedAt, totalDurationMs, now) : [],
  );

  function isSelected(block: AgentBlock): boolean {
    return (
      selectedBlock?.stepNumber === block.stepNumber && selectedBlock?.agentName === block.agentName
    );
  }
</script>

{#if !sessionView || !hasBlocks}
  <div class="waterfall-empty">
    <span class="empty-label">Run a job to see the execution timeline</span>
  </div>
{:else}
  <div class="waterfall">
    <!-- Time axis header -->
    <div class="header">
      <div class="label-col">
        <span class="header-text">Agent</span>
      </div>
      <div class="timeline-col">
        <span class="tick tick--zero">0s</span>
        {#each ticks as tick (tick.ms)}
          <span class="tick" style="inset-inline-start: {tick.pct}%">
            {formatMs(tick.ms)}
          </span>
        {/each}
      </div>
    </div>

    <!-- Agent rows -->
    <div class="rows">
      {#each blocks as block, i (block.stepNumber ?? `${block.agentName}-${i}`)}
        {#if block.status !== "pending"}
          {@const layout = barLayouts[i]}
          {@const left = layout?.left ?? 0}
          {@const width = layout?.width ?? 0}
          {@const rightEdge = left + width}
          {@const isSkipped = block.status === "skipped"}
          <button
            class="row {rowStatusClasses(block.status)}"
            class:row--selected={isSelected(block)}
            onclick={() => onselect(block)}
            in:fly={{ y: 8, duration: 200 }}
          >
            <div class="label-col">
              <span class="step-name">
                {block.stateId ? humanizeStepName(block.stateId) : block.agentName}
              </span>
              <span class="agent-id">{block.agentName}</span>
            </div>
            <div class="timeline-col">
              <!-- Grid lines -->
              {#each ticks as tick (tick.ms)}
                <div class="grid-line" style="inset-inline-start: {tick.pct}%"></div>
              {/each}
              <!-- Bar -->
              <div
                class="bar bar--{block.status}"
                style="inset-inline-start: {left}%; inline-size: {width}%"
              ></div>
              {#if isSkipped}
                <span
                  class="duration-label duration-label--skipped"
                  style="inset-inline-start: {rightEdge}%"
                >
                  Skipped
                </span>
              {:else if block.status === "running" && block.startedAt}
                <span class="duration-label" style="inset-inline-start: {rightEdge}%">
                  {formatMs(now - Date.parse(block.startedAt))}
                </span>
              {:else if block.durationMs}
                <span class="duration-label" style="inset-inline-start: {rightEdge}%">
                  {formatMs(block.durationMs)}
                </span>
              {/if}
            </div>
          </button>
        {/if}
      {/each}
    </div>
  </div>
{/if}

<style>
  .waterfall {
    block-size: 100%;
    display: flex;
    flex-direction: column;
    font-family: var(--font-mono);
    font-size: var(--font-size-0);
    inline-size: 100%;
    overflow-y: auto;
  }

  .waterfall-empty {
    align-items: center;
    block-size: 100%;
    display: flex;
    inline-size: 100%;
    justify-content: center;
  }

  .empty-label {
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    font-family: var(--font-mono);
    font-size: var(--font-size-1);
  }

  /* ---- Shared column widths ---- */

  .label-col {
    flex: 0 0 160px;
    min-inline-size: 0;
    padding-inline-end: var(--size-2);
  }

  .timeline-col {
    flex: 1 1 0;
    min-inline-size: 0;
    position: relative;
  }

  /* ---- Header (time axis) ---- */

  .header {
    align-items: flex-end;
    border-block-end: 1px solid color-mix(in srgb, var(--color-text), transparent 85%);
    display: flex;
    padding-block: var(--size-1) var(--size-2);
    padding-inline-end: 60px;
    padding-inline-start: var(--size-3);
  }

  .header-text {
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
  }

  .header .timeline-col {
    block-size: var(--size-4);
  }

  .tick {
    color: color-mix(in srgb, var(--color-text), transparent 60%);
    inset-block-end: 0;
    position: absolute;
    transform: translateX(-50%);
    user-select: none;
    white-space: nowrap;
  }

  .tick--zero {
    inset-inline-start: 0;
    transform: none; /* Don't center the 0 tick — left-align it */
  }

  /* ---- Rows ---- */

  .rows {
    flex: 1 1 0;
  }

  .row {
    align-items: center;
    background: none;
    border: none;
    border-block-end: 1px solid color-mix(in srgb, var(--color-text), transparent 93%);
    cursor: pointer;
    display: flex;
    font-family: inherit;
    font-size: inherit;
    inline-size: 100%;
    padding-block: var(--size-2);
    padding-inline-end: 60px;
    padding-inline-start: var(--size-3);
    text-align: start;
    transition: background-color 80ms ease;
  }

  .row:hover {
    background: color-mix(in srgb, var(--color-text), transparent 96%);
  }

  .row--failed {
    border-inline-start: 3px solid var(--color-error);
  }

  .row--skipped {
    opacity: 0.6;
  }

  .row--running {
    animation: border-pulse 1.5s ease-in-out infinite;
    border-inline-start: 3px solid var(--color-info);
  }

  .row--selected {
    background: color-mix(in srgb, var(--color-info), transparent 92%);
  }

  .row--selected:hover {
    background: color-mix(in srgb, var(--color-info), transparent 88%);
  }

  .row .label-col {
    display: flex;
    flex-direction: column;
    gap: var(--size-0-5);
    overflow: hidden;
  }

  .step-name {
    color: var(--color-text);
    font-weight: var(--font-weight-6);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .agent-id {
    color: color-mix(in srgb, var(--color-text), transparent 10%);
    font-size: calc(var(--font-size-0) - 1px);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .row .timeline-col {
    block-size: 18px;
  }

  /* ---- Grid lines ---- */

  .grid-line {
    background: color-mix(in srgb, var(--color-text), transparent 93%);
    inline-size: 1px;
    inset-block: 0;
    pointer-events: none;
    position: absolute;
  }

  /* ---- Bars ---- */

  .bar {
    align-items: center;
    border-radius: var(--radius-1);
    display: flex;
    inset-block: 2px;
    min-inline-size: 2px;
    overflow: hidden;
    position: absolute;
  }

  .bar--running {
    animation: pulse 1.5s ease-in-out infinite;
    background: var(--color-info);
  }

  .bar--completed {
    background: color-mix(in srgb, var(--color-info), transparent 15%);
  }

  .bar--failed {
    background: var(--color-error);
  }

  .bar--skipped {
    background: none;
    border: 1px dashed color-mix(in srgb, var(--color-text), transparent 10%);
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 0.6;
    }
    50% {
      opacity: 1;
    }
  }

  @keyframes border-pulse {
    0%,
    100% {
      border-inline-start-color: color-mix(in srgb, var(--color-info), transparent 40%);
    }
    50% {
      border-inline-start-color: var(--color-info);
    }
  }

  /* ---- Duration labels ---- */

  .duration-label {
    align-items: center;
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    display: flex;
    font-size: var(--font-size-0);
    inset-block: 0;
    margin-inline-start: var(--size-2);
    pointer-events: none;
    position: absolute;
    white-space: nowrap;
  }

  .duration-label--skipped {
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    font-style: italic;
  }

  /* ---- Running bar grow animation ---- */

  .bar--running {
    transition: inline-size 300ms ease-out;
  }

  .bar--completed,
  .bar--failed {
    transition: inline-size 200ms cubic-bezier(0.34, 1.56, 0.64, 1);
  }

  /* ---- Reduced motion ---- */

  @media (prefers-reduced-motion: reduce) {
    .bar--running {
      animation: none;
    }
    .row--running {
      animation: none;
    }
    .bar--completed,
    .bar--failed {
      transition: none;
    }
    .bar--running {
      transition: none;
    }
  }
</style>
