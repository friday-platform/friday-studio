<!--
  Right sidebar for inspector session mode — mirrors the platform session
  detail page's sidebar layout (job, summary, details sections).

  Always visible when a session is loaded. Provides session context while
  the user drills into waterfall blocks.

  @component
  @param {import("@atlas/core/session/session-events").SessionView} sessionView
  @param {{ title?: string; description?: string }} jobSpec
-->

<script lang="ts">
  import type { SessionView } from "@atlas/core/session/session-events";

  interface Props {
    sessionView: SessionView;
    jobSpec: { title?: string; description?: string };
  }

  const { sessionView, jobSpec }: Props = $props();

  const agentCount = $derived(sessionView.agentBlocks.length);
  const skippedCount = $derived(
    sessionView.agentBlocks.filter((b) => b.status === "skipped").length,
  );

  const isActive = $derived(sessionView.status === "active");

  /** Live elapsed timer for active sessions. */
  let elapsedMs = $state(0);
  $effect(() => {
    if (!isActive || !sessionView.startedAt) {
      elapsedMs = 0;
      return;
    }
    const startEpoch = Date.parse(sessionView.startedAt);
    const tick = () => { elapsedMs = Date.now() - startEpoch; };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  });

  const durationLabel = $derived.by(() => {
    if (isActive) return formatMs(elapsedMs);
    if (sessionView.durationMs) return formatMs(sessionView.durationMs);
    return null;
  });

  function formatMs(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    const mins = Math.floor(ms / 60000);
    const secs = Math.round((ms % 60000) / 1000);
    return `${mins}m${secs > 0 ? ` ${secs}s` : ""}`;
  }

  function formatDate(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function statusLabel(status: string): string {
    return status.charAt(0).toUpperCase() + status.slice(1);
  }
</script>

<aside class="session-sidebar">
  <!-- Job section -->
  <div class="sidebar-section">
    <h3>Job</h3>
    <p class="job-name">{jobSpec.title ?? sessionView.jobName}</p>
    {#if jobSpec.description}
      <p class="job-description">{jobSpec.description}</p>
    {/if}
    <p class="workspace-id">{sessionView.workspaceId}</p>
  </div>

  <!-- AI Summary + key details -->
  {#if sessionView.aiSummary?.summary}
    <div class="sidebar-section">
      <h3>Summary</h3>
      <p class="summary-text">{sessionView.aiSummary.summary}</p>
      {#if sessionView.aiSummary.keyDetails && sessionView.aiSummary.keyDetails.length > 0}
        <dl class="key-details">
          {#each sessionView.aiSummary.keyDetails as detail (detail.label)}
            <div class="key-detail-row">
              <dt>{detail.label}</dt>
              <dd>
                {#if detail.url}
                  <a href={detail.url} target="_blank" rel="noopener noreferrer">{detail.value}</a>
                {:else}
                  {detail.value}
                {/if}
              </dd>
            </div>
          {/each}
        </dl>
      {/if}
    </div>
  {/if}

  <!-- Details section -->
  <div class="sidebar-section">
    <h3>Details</h3>
    <dl class="key-details">
      <div class="key-detail-row">
        <dt>Status</dt>
        <dd>
          <span class="status-badge status--{sessionView.status}">
            {statusLabel(sessionView.status)}
          </span>
        </dd>
      </div>
      {#if sessionView.startedAt}
        <div class="key-detail-row">
          <dt>Started</dt>
          <dd>{formatDate(sessionView.startedAt)}</dd>
        </div>
      {/if}
      {#if durationLabel}
        <div class="key-detail-row">
          <dt>Duration</dt>
          <dd>{durationLabel}</dd>
        </div>
      {/if}
      <div class="key-detail-row">
        <dt>Steps</dt>
        <dd>{agentCount}{skippedCount > 0 ? ` (${skippedCount} skipped)` : ""}</dd>
      </div>
      {#if sessionView.task}
        <div class="key-detail-row">
          <dt>Task</dt>
          <dd>{sessionView.task}</dd>
        </div>
      {/if}
      {#if sessionView.error}
        <div class="key-detail-row">
          <dt>Error</dt>
          <dd class="error-text">{sessionView.error}</dd>
        </div>
      {/if}
      <div class="key-detail-row">
        <dt>Run ID</dt>
        <dd class="mono">{sessionView.sessionId}</dd>
      </div>
    </dl>
  </div>
</aside>

<style>
  .session-sidebar {
    background: var(--color-surface-1);
    border-inline-start: 1px solid color-mix(in srgb, var(--color-text), transparent 85%);
    display: flex;
    flex-direction: column;
    gap: var(--size-8);
    overflow: auto;
    padding: var(--size-6) var(--size-5);
    scrollbar-width: thin;
  }

  .sidebar-section {
    display: flex;
    flex-direction: column;
    gap: var(--size-3);

    h3 {
      color: color-mix(in srgb, var(--color-text), transparent 30%);
      font-size: var(--font-size-1);
      font-weight: var(--font-weight-5);
      letter-spacing: var(--font-letterspacing-2);
      text-transform: uppercase;
    }
  }

  .job-name {
    color: var(--color-text);
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-6);
  }

  .job-description {
    color: color-mix(in srgb, var(--color-text), transparent 45%);
    font-size: var(--font-size-1);
    line-height: var(--font-lineheight-3);
  }

  .workspace-id {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-2);
  }

  .summary-text {
    color: color-mix(in srgb, var(--color-text), transparent 20%);
    font-size: var(--font-size-2);
    line-height: var(--font-lineheight-3);
  }

  .key-details {
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
  }

  .key-detail-row {
    display: flex;
    flex-direction: column;
    gap: var(--size-0-5);

    dt {
      color: var(--color-text);
      font-size: var(--font-size-2);
      font-weight: var(--font-weight-5);
    }

    dd {
      color: color-mix(in srgb, var(--color-text), transparent 40%);
      font-size: var(--font-size-2);
    }

    dd a {
      color: color-mix(in srgb, var(--color-text), transparent 40%);
      text-decoration: underline;
      text-decoration-color: color-mix(in srgb, currentColor, transparent 70%);
      text-underline-offset: var(--size-0-5);
    }

    dd a:hover {
      color: var(--color-text);
    }
  }

  .mono {
    font-family: var(--font-mono);
    font-size: var(--font-size-1);
    word-break: break-all;
  }

  .error-text {
    color: var(--color-error, #ef4444);
  }

  /* ---- Status badges ---- */

  .status-badge {
    border-radius: var(--radius-1);
    font-size: var(--font-size-0);
    font-weight: var(--font-weight-6);
    padding: var(--size-0-5) var(--size-1-5);
    text-transform: uppercase;
  }

  .status--completed {
    background: color-mix(in srgb, var(--color-success, #22c55e), transparent 85%);
    color: var(--color-success, #22c55e);
  }

  .status--failed {
    background: color-mix(in srgb, var(--color-error, #ef4444), transparent 85%);
    color: var(--color-error, #ef4444);
  }

  .status--active {
    background: color-mix(in srgb, var(--color-info, #3b82f6), transparent 85%);
    color: var(--color-info, #3b82f6);
  }

  .status--skipped {
    background: color-mix(in srgb, var(--color-text), transparent 85%);
    color: color-mix(in srgb, var(--color-text), transparent 40%);
  }
</style>
