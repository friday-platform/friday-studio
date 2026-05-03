<!--
  Status pill badge for session/step execution states.

  Renders a rounded pill with icon + label, colored by status.

  @component
  @param {"completed" | "failed" | "active" | "skipped" | "pending" | "cancelled" | "interrupted"} status - Execution status
  @param {string} [label] - Override the default label text
-->

<script lang="ts">
  type Status =
    | "completed"
    | "failed"
    | "active"
    | "skipped"
    | "pending"
    | "cancelled"
    | "interrupted";

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
    interrupted: "Interrupted",
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
  class:status-badge--interrupted={status === "interrupted"}
>
  {displayLabel}
</span>

<style>
  .status-badge {
    border-radius: var(--radius-1);
    display: inline-flex;
    font-size: var(--font-size-0);
    font-weight: var(--font-weight-5);
    inline-size: fit-content;
    letter-spacing: 0.04em;
    padding: 2px 6px;
    text-transform: uppercase;
  }

  .status-badge--completed {
    background-color: color-mix(in srgb, var(--color-success), transparent 80%);
    color: color-mix(in srgb, var(--color-success), var(--color-text) 25%);
  }

  .status-badge--failed {
    background-color: color-mix(in srgb, var(--color-error), transparent 80%);
    color: color-mix(in srgb, var(--color-error), var(--color-text) 20%);
  }

  .status-badge--active {
    background-color: color-mix(in srgb, var(--color-warning), transparent 80%);
    color: color-mix(in srgb, var(--color-warning), var(--color-text) 20%);
  }

  .status-badge--skipped {
    background-color: color-mix(in srgb, var(--color-text), transparent 88%);
    color: color-mix(in srgb, var(--color-text), transparent 40%);
  }

  .status-badge--pending {
    background-color: color-mix(in srgb, var(--color-text), transparent 90%);
    color: color-mix(in srgb, var(--color-text), transparent 50%);
  }

  .status-badge--cancelled {
    background-color: color-mix(in srgb, var(--color-text), transparent 88%);
    color: color-mix(in srgb, var(--color-text), transparent 40%);
  }

  .status-badge--interrupted {
    background-color: color-mix(in srgb, var(--color-warning), transparent 80%);
    color: color-mix(in srgb, var(--color-warning), var(--color-text) 20%);
  }
</style>
