<!--
  Status pill badge for session/step execution states.

  Renders a rounded pill with icon + label, colored by status.
  Matches the web-client "Complete" / "Failed" / "Running" badge pattern.

  @component
  @param {"completed" | "failed" | "active" | "skipped" | "pending" | "cancelled"} status - Execution status
  @param {string} [label] - Override the default label text
-->

<script lang="ts">
  import { IconSmall } from "./icons/index.js";

  type Status = "completed" | "failed" | "active" | "skipped" | "pending" | "cancelled";

  type Props = {
    status: Status;
    label?: string;
  };

  let { status, label }: Props = $props();

  const defaultLabels: Record<Status, string> = {
    completed: "Complete",
    failed: "Failed",
    active: "Running",
    skipped: "Skipped",
    pending: "Pending",
    cancelled: "Cancelled",
  };

  const displayLabel = $derived(label ?? defaultLabels[status]);
</script>

<span
  class="status-badge"
  class:status-badge--completed={status === "completed"}
  class:status-badge--failed={status === "failed"}
  class:status-badge--active={status === "active"}
  class:status-badge--skipped={status === "skipped"}
  class:status-badge--pending={status === "pending"}
  class:status-badge--cancelled={status === "cancelled"}
>
  <span class="status-badge-icon">
    {#if status === "completed"}
      <IconSmall.Check />
    {:else if status === "failed"}
      <IconSmall.Close />
    {:else if status === "active"}
      <span class="spin"><IconSmall.Progress /></span>
    {:else if status === "cancelled"}
      <IconSmall.Close />
    {/if}
  </span>
  {displayLabel}
</span>

<style>
  .status-badge {
    align-items: center;
    border-radius: var(--radius-round);
    display: inline-flex;
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    gap: var(--size-0-5);
    inline-size: fit-content;
    padding: var(--size-0-75) var(--size-2-5) var(--size-0-75) var(--size-1-5);
  }

  .status-badge--completed {
    background-color: var(--color-success);
    color: var(--color-surface-1);
  }

  .status-badge--failed {
    background-color: var(--color-error);
    color: var(--color-surface-1);
  }

  .status-badge--active {
    background-color: var(--color-warning);
    color: var(--color-surface-1);
  }

  .status-badge--skipped {
    background-color: var(--color-text);
    color: var(--color-surface-1);
    opacity: 0.4;
  }

  .status-badge--pending {
    background-color: var(--color-text);
    color: var(--color-surface-1);
    opacity: 0.3;
  }

  .status-badge--cancelled {
    background-color: var(--color-text);
    color: var(--color-surface-1);
    opacity: 0.5;
  }

  .status-badge-icon {
    align-items: center;
    block-size: 16px;
    display: flex;
    flex-shrink: 0;
    inline-size: 16px;
    justify-content: center;
  }

  .spin {
    animation: spin 2s linear infinite;
    display: flex;
  }

  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }
</style>
