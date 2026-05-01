<!--
  Buildkite-style session progress card.

  Shows a session's pipeline steps as horizontal status pills with
  real-time status. Active sessions poll for updates. Completed/failed
  sessions display their final state.

  Signal nodes render as a muted trigger tag, visually separated from
  agent-step pills since signals can't fail.

  @component
  @param {import("@atlas/core/session/session-events").SessionSummary} session - Session to display
  @param {import("@atlas/config/topology").Topology} topology - Workspace topology for step labels
  @param {string} workspaceId - Workspace ID for navigation
-->

<script lang="ts">
  import { humanizeStepName } from "@atlas/config/pipeline-utils";
  import type { Topology } from "@atlas/config/topology";
  import type { SessionSummary } from "@atlas/core/session/session-events";
  import { StatusBadge } from "@atlas/ui";

  type Props = {
    session: SessionSummary;
    topology: Topology;
    workspaceId: string;
    /** Optional map from job ID to human-readable title. */
    jobTitles?: Record<string, string>;
  };

  let { session, topology, workspaceId, jobTitles = {} }: Props = $props();

  /** Signal nodes for THIS job only — filter by job association from topology. */
  const signalSteps = $derived.by(() => {
    const jobId = session.jobName;
    return topology.nodes.filter(
      (n) =>
        n.type === "signal" &&
        Array.isArray(n.metadata.jobIds) &&
        n.metadata.jobIds.includes(jobId),
    );
  });

  /** Readable signal provider label (lowercase). */
  function signalType(node: { metadata: Record<string, unknown> }): string {
    const provider = node.metadata?.provider;
    if (typeof provider !== "string") return "signal";
    if (provider === "http") return "webhook";
    return provider.toLowerCase();
  }

  function formatDuration(ms: number | undefined): string {
    if (ms === undefined) return "";
    if (ms < 1_000) return `${ms}ms`;
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.floor((ms % 60_000) / 1_000);
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
  }

  function formatTime(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  const sessionHref = $derived(`/platform/${workspaceId}/sessions/${session.sessionId}`);

  const isActive = $derived(session.status === "active");
  const isFailed = $derived(session.status === "failed");
  const badgeStatus = $derived(
    session.status === "skipped"
      ? ("skipped" as const)
      : session.status === "active"
        ? ("active" as const)
        : session.status === "failed"
          ? ("failed" as const)
          : ("completed" as const),
  );
</script>

<a
  href={sessionHref}
  class="progress-card"
  class:progress-card--active={isActive}
  class:progress-card--failed={isFailed}
>
  <div class="card-header">
    <span class="job-name">{jobTitles[session.jobName] ?? humanizeStepName(session.jobName)}</span>
    <StatusBadge status={badgeStatus} />
    {#if signalSteps.length > 0}
      <span class="signal-chips">
        {#each signalSteps as signal (signal.id)}
          <span class="signal-chip signal-chip--{signalType(signal)}">{signalType(signal)}</span>
        {/each}
      </span>
    {/if}
  </div>
  {#if session.aiSummary?.summary || session.task}
    <span class="task-text">{session.aiSummary?.summary ?? session.task}</span>
  {/if}

  <div class="card-footer">
    <span class="footer-meta">
      Started {formatTime(session.startedAt)}
      {#if session.durationMs}
        <span class="meta-sep">&middot;</span>
        {isActive ? "Running" : "Ran"}
        {formatDuration(session.durationMs)}
      {/if}
    </span>
  </div>
</a>

<style>
  .progress-card {
    background: var(--color-surface-1);
    border-radius: var(--radius-3);
    box-shadow: var(--shadow-1);
    color: inherit;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: var(--size-4);
    padding: var(--size-5) var(--size-6);
    text-decoration: none;
  }

  .progress-card--active {
  }

  .progress-card--failed {
  }

  /* Header */
  .card-header {
    align-items: center;
    display: flex;
    gap: var(--size-3);
  }

  .job-name {
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-6);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .task-text {
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    display: -webkit-box;
    font-size: var(--font-size-2);
    line-height: var(--font-lineheight-3);
    overflow: hidden;
  }

  /* Signal chips — compact badges after the status badge */
  .signal-chips {
    align-items: center;
    display: flex;
    gap: var(--size-1);
    margin-inline-start: auto;
  }

  .signal-chip {
    border-radius: var(--radius-1);
    font-size: var(--font-size-0);
    font-weight: var(--font-weight-5);
    letter-spacing: 0.04em;
    padding: 2px 6px;
    text-transform: uppercase;
  }

  .signal-chip--webhook {
    background-color: light-dark(hsl(220 60% 90%), hsl(220 30% 20%));
    color: light-dark(hsl(220 60% 35%), hsl(220 60% 75%));
  }

  .signal-chip--schedule {
    background-color: light-dark(hsl(270 50% 90%), hsl(270 30% 20%));
    color: light-dark(hsl(270 50% 40%), hsl(270 60% 75%));
  }

  .signal-chip--signal,
  .signal-chip--file {
    background-color: color-mix(in srgb, var(--color-text), transparent 88%);
    color: color-mix(in srgb, var(--color-text), transparent 25%);
  }

  /* Footer */
  .card-footer {
    align-items: center;
    display: flex;
    gap: var(--size-3);
    justify-content: space-between;
  }

  .footer-meta {
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    display: flex;
    font-size: var(--font-size-1);
    gap: var(--size-1-5);
  }

  .meta-sep {
    opacity: 0.5;
  }
</style>
