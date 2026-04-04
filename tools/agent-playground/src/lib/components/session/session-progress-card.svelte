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
  import { mapSessionToStepStatus, type StepStatus } from "@atlas/config/map-session-status";
  import { humanizeStepName } from "@atlas/config/pipeline-utils";
  import type { Topology } from "@atlas/config/topology";
  import type { SessionSummary } from "@atlas/core/session/session-events";
  import { StatusBadge } from "@atlas/ui";
  import { createQuery } from "@tanstack/svelte-query";
  import { sessionQueries } from "$lib/queries";

  type Props = {
    session: SessionSummary;
    topology: Topology;
    workspaceId: string;
    /** Optional map from job ID to human-readable title. */
    jobTitles?: Record<string, string>;
  };

  let { session, topology, workspaceId, jobTitles = {} }: Props = $props();

  const sessionViewQuery = createQuery(() => ({
    ...sessionQueries.view(session.sessionId),
    refetchInterval: session.status === "active" ? 3_000 : false,
  }));

  const stepStatuses = $derived.by((): Map<string, StepStatus> => {
    const view = sessionViewQuery.data;
    if (!view) return new Map();
    return mapSessionToStepStatus(view, topology);
  });

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

  /** Agent-step nodes for this session's job — rendered as status pills. */
  const agentSteps = $derived.by(() => {
    const jobId = session.jobName;
    return topology.nodes.filter((n) => n.type === "agent-step" && n.jobId === jobId);
  });

  /**
   * Corrected step statuses — clamps steps after a failure to "pending"
   * since they never actually ran. The raw data from mapSessionToStepStatus
   * can report downstream steps as "completed" even when the session
   * failed early, because the FSM pre-creates blocks.
   */
  const correctedStatuses = $derived.by((): Map<string, StepStatus> => {
    const result = new Map<string, StepStatus>();
    let hitFailure = false;
    for (const node of agentSteps) {
      const raw = stepStatuses.get(node.id) ?? "pending";
      if (hitFailure) {
        result.set(node.id, "pending");
      } else {
        result.set(node.id, raw);
        if (raw === "failed") hitFailure = true;
      }
    }
    return result;
  });

  function getStepStatus(nodeId: string): StepStatus {
    return correctedStatuses.get(nodeId) ?? "pending";
  }

  /** Extract the signal provider from metadata for display. */
  function signalType(node: { metadata: Record<string, unknown> }): string {
    const provider = node.metadata?.provider;
    if (typeof provider !== "string") return "SIGNAL";
    if (provider === "http") return "WEBHOOK";
    return provider.toUpperCase();
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
  </div>
  {#if session.aiSummary?.summary || session.task}
    <span class="task-text">{session.aiSummary?.summary ?? session.task}</span>
  {/if}

  <div class="pipeline-strip">
    {#if signalSteps.length > 0}
      <div class="signal-trigger">
        {#each signalSteps as signal (signal.id)}
          <span class="signal-tag">{signalType(signal)}</span>
        {/each}
        <span class="trigger-arrow">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path
              d="M2 6H10M10 6L7 3M10 6L7 9"
              stroke="currentColor"
              stroke-width="1.25"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </span>
      </div>
    {/if}

    <div class="step-pills">
      {#each agentSteps as node, i (node.id)}
        {@const status = getStepStatus(node.id)}
        {#if i > 0}
          <span
            class="step-connector"
            class:step-connector--done={status === "completed" || status === "skipped" || status === "failed"}
          ></span>
        {/if}
        <span
          class="step-pill"
          class:step-pill--completed={status === "completed"}
          class:step-pill--skipped={status === "skipped"}
          class:step-pill--active={status === "active"}
          class:step-pill--failed={status === "failed"}
          class:step-pill--pending={status === "pending"}
        >
          <span class="step-icon">
            {#if status === "completed"}
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path
                  d="M2.5 6L5 8.5L9.5 3.5"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            {:else if status === "skipped"}
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path
                  d="M3 3L7 6L3 9"
                  stroke="currentColor"
                  stroke-width="1.25"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
                <line x1="8.5" y1="3" x2="8.5" y2="9" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" />
              </svg>
            {:else if status === "active"}
              <span class="pulse-dot"></span>
            {:else if status === "failed"}
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path
                  d="M3 3L9 9M9 3L3 9"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linecap="round"
                />
              </svg>
            {:else}
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <circle cx="6" cy="6" r="4" stroke="currentColor" stroke-width="1.25" fill="none" />
              </svg>
            {/if}
          </span>
          <span class="step-name">{node.label}</span>
        </span>
      {/each}
    </div>
  </div>

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
    -webkit-line-clamp: 1;
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    display: -webkit-box;
    font-size: var(--font-size-2);
    line-height: var(--font-lineheight-3);
    overflow: hidden;
  }

  /* Pipeline strip — signal trigger + agent step pills */
  .pipeline-strip {
    align-items: center;
    display: flex;
    gap: var(--size-2);
  }

  /* Signal trigger — muted tag, visually distinct from steps */
  .signal-trigger {
    align-items: center;
    display: flex;
    flex-shrink: 0;
    gap: var(--size-1-5);
  }

  .signal-tag {
    border: 1px solid color-mix(in srgb, var(--color-text), transparent 25%);
    border-radius: var(--radius-2);
    color: var(--color-text);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-0);
    font-weight: var(--font-weight-5);
    letter-spacing: var(--font-letterspacing-2);
    padding: var(--size-1) var(--size-2);
  }

  .trigger-arrow {
    color: color-mix(in srgb, var(--color-text), transparent 60%);
    display: flex;
  }

  /* Step pills */
  .step-pills {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--size-1-5);
  }

  .step-connector {
    background: var(--color-border-2);
    block-size: 1px;
    inline-size: var(--size-2);
  }

  .step-connector--done {
    background: color-mix(in srgb, var(--color-text), transparent 60%);
  }

  .step-pill {
    align-items: center;
    border: 1px solid color-mix(in srgb, var(--color-text), transparent 25%);
    border-radius: var(--radius-round);
    color: var(--color-text);
    display: flex;
    gap: var(--size-1-5);
    padding: var(--size-1-5) var(--size-3) var(--size-1-5) var(--size-2);
  }

  .step-pill--completed {
    .step-icon {
      color: var(--color-success);
    }
  }

  .step-pill--active {
    border-color: color-mix(in srgb, var(--color-warning), transparent 25%);

    .step-icon {
      color: var(--color-warning);
    }
  }

  .step-pill--failed {
    .step-icon {
      color: var(--color-error);
    }
  }

  .step-pill--skipped {
    border-color: color-mix(in srgb, var(--color-text), transparent 60%);
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    border-style: dashed;
  }

  .step-pill--pending {
    border-color: color-mix(in srgb, var(--color-text), transparent 60%);
    color: color-mix(in srgb, var(--color-text), transparent 40%);
  }

  .step-icon {
    align-items: center;
    block-size: 12px;
    display: flex;
    flex-shrink: 0;
    inline-size: 12px;
    justify-content: center;
  }

  .pulse-dot {
    animation: pulse 1.5s ease-in-out infinite;
    background: currentColor;
    block-size: 6px;
    border-radius: 50%;
    inline-size: 6px;
  }

  .step-name {
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    white-space: nowrap;
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 0.4;
    }
    50% {
      opacity: 1;
    }
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
