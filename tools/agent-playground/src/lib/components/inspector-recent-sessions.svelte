<!--
  Toolbar dropdown showing recent sessions for the current workspace + job.
  Clicking an item loads that session into the inspector.

  @component
  @param {string} workspaceId - Current workspace ID
  @param {string} jobName - Current job ID
  @param {(sessionId: string) => void} onselect - Called when a session is picked
-->
<script lang="ts">
  import { SessionSummarySchema, type SessionSummary } from "@atlas/core/session/session-events";
  import { DropdownMenu } from "@atlas/ui";
  import { createQuery } from "@tanstack/svelte-query";
  import { getDaemonClient } from "$lib/daemon-client";
  import { z } from "zod";

  const {
    workspaceId,
    jobName,
    onselect,
  }: {
    workspaceId: string;
    jobName: string;
    onselect: (sessionId: string) => void;
  } = $props();

  const sessionsQuery = createQuery<SessionSummary[]>(() => ({
    queryKey: ["sessions", workspaceId],
    queryFn: async () => {
      const client = getDaemonClient();
      const res = await client.sessions.index.$get({ query: { workspaceId } });
      if (!res.ok) return [];
      const data = await res.json();
      return z.array(SessionSummarySchema).parse(data.sessions);
    },
    enabled: !!workspaceId && !!jobName,
    refetchInterval: 5_000,
  }));

  /** Filter to current job, pin active to top, cap at 5. */
  const recentSessions = $derived.by(() => {
    const all = sessionsQuery.data ?? [];
    const filtered = all.filter((s) => s.jobName === jobName);
    const active = filtered.filter((s) => s.status === "active");
    const rest = filtered
      .filter((s) => s.status !== "active")
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
    return [...active, ...rest].slice(0, 5);
  });

  function relativeTime(iso: string): string {
    const delta = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
    if (delta < 60) return `${delta}s ago`;
    const minutes = Math.floor(delta / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  function formatDuration(ms: number | undefined): string {
    if (ms === undefined) return "--";
    if (ms < 1_000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
    return `${(ms / 60_000).toFixed(1)}m`;
  }

  function truncate(text: string, max: number): string {
    if (text.length <= max) return text;
    return text.slice(0, max).trimEnd() + "…";
  }
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger class="runs-trigger">
    <span class="trigger-text">Recent runs</span>
    <svg class="chevron" width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" stroke-width="1.5" />
    </svg>
  </DropdownMenu.Trigger>
  <DropdownMenu.Content>
    {#if sessionsQuery.isLoading}
      <DropdownMenu.Empty>Loading…</DropdownMenu.Empty>
    {:else if recentSessions.length === 0}
      <DropdownMenu.Empty>No recent runs</DropdownMenu.Empty>
    {:else}
      {#each recentSessions as session (session.sessionId)}
        <DropdownMenu.Item onclick={() => onselect(session.sessionId)}>
          <span class="session-item">
            {#if session.status === "completed"}
              <svg class="status-icon status-icon--ok" width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M3.5 7L6 9.5L10.5 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            {:else if session.status === "failed"}
              <svg class="status-icon status-icon--fail" width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M4 4L10 10M10 4L4 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
              </svg>
            {:else}
              <svg class="status-icon status-icon--active" width="14" height="14" viewBox="0 0 14 14" fill="none">
                <circle cx="7" cy="7" r="3" fill="currentColor" />
              </svg>
            {/if}
            <span class="session-time">{relativeTime(session.startedAt)}</span>
            {#if session.aiSummary?.keyDetails?.length}
              {@const detail = session.aiSummary.keyDetails[0]}
              {#if detail}
                <span class="session-detail">{truncate(detail.value, 40)}</span>
              {/if}
            {/if}
            <span class="session-duration">{formatDuration(session.durationMs)}</span>
          </span>
        </DropdownMenu.Item>
      {/each}
    {/if}
  </DropdownMenu.Content>
</DropdownMenu.Root>

<style>
  :global(.runs-trigger) {
    align-items: center;
    background: color-mix(in srgb, var(--color-surface), transparent 50%);
    border: 1px solid color-mix(in srgb, var(--color-text), transparent 85%);
    border-radius: var(--radius-2);
    color: var(--color-text);
    cursor: default;
    display: inline-flex;
    font-family: inherit;
    font-size: var(--font-size-1);
    gap: var(--size-2);
    padding: var(--size-1) var(--size-2);
  }

  .trigger-text {
    text-align: start;
  }

  .chevron {
    flex: none;
    opacity: 0.5;
  }

  .session-item {
    align-items: center;
    display: flex;
    gap: var(--size-2);
    inline-size: 100%;
  }

  .status-icon {
    flex-shrink: 0;
  }

  .status-icon--ok {
    color: var(--color-green);
  }

  .status-icon--fail {
    color: var(--color-red);
  }

  .status-icon--active {
    color: var(--color-yellow);
  }

  .session-time {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    flex-shrink: 0;
    font-size: var(--font-size-1);
  }

  .session-detail {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    flex: 1;
    font-size: var(--font-size-1);
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .session-duration {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    flex-shrink: 0;
    font-family: var(--font-mono);
    font-size: var(--font-size-1);
    margin-inline-start: auto;
    min-inline-size: 3ch;
    text-align: end;
  }
</style>
