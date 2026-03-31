<!--
  Compact recent runs list for the cockpit page.
  Shows last 5 runs with status indicator, timestamp, and duration.
-->
<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import { goto } from "$app/navigation";
  import { sessionQueries } from "$lib/queries";

  const { workspaceId }: { workspaceId: string } = $props();

  const sessionsQuery = createQuery(() => ({
    ...sessionQueries.list(workspaceId),
    refetchInterval: 5_000,
  }));

  /** Show at most 5, active pinned to top. */
  const recentSessions = $derived.by(() => {
    const data = sessionsQuery.data ?? [];
    const active = data.filter((s) => s.status === "active");
    const rest = data.filter((s) => s.status !== "active");
    return [...active, ...rest].slice(0, 5);
  });

  function formatDuration(ms: number | undefined): string {
    if (ms === undefined) return "--";
    if (ms < 1_000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
    return `${(ms / 60_000).toFixed(1)}m`;
  }

  function formatTime(iso: string): string {
    const d = new Date(iso);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    if (isToday) {
      return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    }
    return d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function navigateToSession(sessionId: string) {
    goto(`/platform/${workspaceId}/sessions/${sessionId}`);
  }
</script>

<section class="recent-sessions">
  <div class="section-header">
    <h2 class="section-title">Recent Runs</h2>
    <a class="view-all" href="/platform/{workspaceId}/sessions">View All</a>
  </div>

  {#if sessionsQuery.isLoading}
    <p class="empty-hint">Loading...</p>
  {:else if recentSessions.length === 0}
    <p class="empty-hint">No runs yet</p>
  {:else}
    <div class="session-list">
      {#each recentSessions as session (session.sessionId)}
        <button
          class="session-row"
          class:active={session.status === "active"}
          class:failed={session.status === "failed"}
          onclick={() => navigateToSession(session.sessionId)}
        >
          <span
            class="status-dot"
            class:dot-active={session.status === "active"}
            class:dot-failed={session.status === "failed"}
            class:dot-completed={session.status === "completed"}
          ></span>
          <span class="session-name">{session.jobName}</span>
          <span class="session-time">{formatTime(session.startedAt)}</span>
          <span class="session-duration">{formatDuration(session.durationMs)}</span>
        </button>
      {/each}
    </div>
  {/if}
</section>

<style>
  .recent-sessions {
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
  }

  .section-header {
    align-items: center;
    display: flex;
    justify-content: space-between;
  }

  .section-title {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    letter-spacing: var(--font-letterspacing-2);
    text-transform: uppercase;
  }

  .view-all {
    color: var(--color-accent);
    font-size: var(--font-size-1);
    text-decoration: none;

    &:hover {
      text-decoration: underline;
    }
  }

  .empty-hint {
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    font-size: var(--font-size-2);
  }

  .session-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  .session-row {
    all: unset;
    align-items: center;
    border-radius: var(--radius-2);
    cursor: pointer;
    display: flex;
    font-size: var(--font-size-2);
    gap: var(--size-3);
    padding: var(--size-2) var(--size-3);
    transition: background-color 100ms ease;

    &:hover {
      background: var(--color-highlight-1);
    }
  }

  .status-dot {
    background: color-mix(in srgb, var(--color-text), transparent 60%);
    border-radius: var(--radius-round);
    flex-shrink: 0;
    block-size: var(--size-1-5);
    inline-size: var(--size-1-5);
  }

  .dot-active {
    background: var(--color-yellow);
  }

  .dot-failed {
    background: var(--color-red);
  }

  .dot-completed {
    background: var(--color-green);
  }

  .session-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .session-time {
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    flex-shrink: 0;
    font-size: var(--font-size-1);
  }

  .session-duration {
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    flex-shrink: 0;
    font-family: var(--font-mono);
    font-size: var(--font-size-1);
    min-width: 3ch;
    text-align: right;
  }
</style>
