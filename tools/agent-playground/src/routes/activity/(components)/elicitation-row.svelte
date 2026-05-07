<!--
  One row in the Activity list.

  Displays kind, question, pendingTool (if any), status pill, and an
  expires-in countdown for pending entries. Click → opens the detail
  panel via the parent's `onselect` callback.

  @component
-->

<script lang="ts">
  import type { Elicitation, ElicitationStatus } from "@atlas/core/elicitations/model";
  import { formatRelative } from "../activity-time.ts";

  type Props = {
    elicitation: Elicitation;
    selected: boolean;
    /** Live "now" tick from parent — drives the countdown without
        each row mounting its own interval. */
    nowMs: number;
    onselect: (id: string) => void;
  };

  let { elicitation, selected, nowMs, onselect }: Props = $props();

  /**
   * Effective status. Backend writes `expired` lazily — until the sweeper
   * runs we still see `pending` envelopes whose `expiresAt` has passed.
   * Treat them as expired in the UI so the row dims out + the detail
   * panel goes read-only.
   */
  const effectiveStatus = $derived<ElicitationStatus>(
    elicitation.status === "pending" && new Date(elicitation.expiresAt).getTime() <= nowMs
      ? "expired"
      : elicitation.status,
  );

  const expiresInLabel = $derived(formatRelative(elicitation.expiresAt, nowMs));

  const STATUS_LABEL: Record<ElicitationStatus, string> = {
    pending: "Pending",
    answered: "Answered",
    declined: "Declined",
    expired: "Expired",
  };

  const KIND_LABEL: Record<string, string> = {
    "tool-allowlist": "tool",
    "auth-refresh": "auth",
    "confirm-action": "confirm",
    "open-question": "ask",
  };
</script>

<button
  class="row"
  class:selected
  class:dimmed={effectiveStatus !== "pending"}
  type="button"
  onclick={() => onselect(elicitation.id)}
>
  <div class="row-main">
    <span class="kind-tag">{KIND_LABEL[elicitation.kind] ?? elicitation.kind}</span>
    <span class="question">{elicitation.question}</span>
    {#if elicitation.pendingTool}
      <span class="pending-tool">
        <span class="muted">tool:</span>
        <code>{elicitation.pendingTool.name}</code>
      </span>
    {/if}
  </div>
  <div class="row-right">
    <span class="status-pill" class:pending={effectiveStatus === "pending"} class:answered={effectiveStatus === "answered"} class:declined={effectiveStatus === "declined"} class:expired={effectiveStatus === "expired"}>
      {STATUS_LABEL[effectiveStatus]}
    </span>
    {#if effectiveStatus === "pending"}
      <span class="expires">expires {expiresInLabel}</span>
    {/if}
  </div>
</button>

<style>
  .row {
    align-items: center;
    background: none;
    border: none;
    border-block-end: 1px solid color-mix(in srgb, var(--color-border-1), transparent 50%);
    column-gap: var(--size-4);
    cursor: pointer;
    display: grid;
    font: inherit;
    grid-template-columns: 1fr auto;
    inline-size: 100%;
    padding: var(--size-3) var(--size-2);
    position: relative;
    text-align: start;
    transition: background-color 120ms ease;
    z-index: 1;
  }

  .row:hover {
    background-color: color-mix(in srgb, var(--color-text), transparent 95%);
  }

  .row.selected {
    background-color: color-mix(in srgb, var(--color-text), transparent 92%);
  }

  .row.dimmed .row-main {
    opacity: 0.6;
  }

  .row-main {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
    min-inline-size: 0;
  }

  .kind-tag {
    align-self: flex-start;
    background-color: color-mix(in srgb, var(--color-text), transparent 88%);
    border-radius: var(--radius-round);
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-6);
    letter-spacing: 0.04em;
    padding: 1px var(--size-2);
    text-transform: uppercase;
  }

  .question {
    color: var(--color-text);
    font-size: var(--font-size-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .pending-tool {
    align-items: center;
    color: color-mix(in srgb, var(--color-text), transparent 45%);
    display: inline-flex;
    font-size: var(--font-size-1);
    gap: var(--size-1);
  }

  .pending-tool code {
    font-family: monospace;
  }

  .muted {
    opacity: 0.7;
  }

  .row-right {
    align-items: center;
    display: flex;
    gap: var(--size-2);
  }

  .status-pill {
    background-color: color-mix(in srgb, var(--color-text), transparent 88%);
    border-radius: var(--radius-round);
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    padding: 2px var(--size-2);
    white-space: nowrap;
  }

  .status-pill.pending {
    background-color: color-mix(in srgb, var(--color-accent, #1f6feb), transparent 80%);
    color: var(--color-accent, #1f6feb);
  }

  .status-pill.answered {
    background-color: color-mix(in srgb, var(--color-success, #238636), transparent 80%);
    color: var(--color-success, #238636);
  }

  .status-pill.declined {
    background-color: color-mix(in srgb, var(--color-warning, #d29922), transparent 80%);
    color: var(--color-warning, #d29922);
  }

  .status-pill.expired {
    background-color: color-mix(in srgb, var(--color-text), transparent 88%);
    color: color-mix(in srgb, var(--color-text), transparent 50%);
  }

  .expires {
    color: color-mix(in srgb, var(--color-text), transparent 45%);
    font-size: var(--font-size-1);
    font-variant-numeric: tabular-nums;
  }
</style>
