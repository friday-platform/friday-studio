<script lang="ts">
  import { GA4, trackEvent } from "@atlas/analytics/ga4";
  import type {
    EphemeralChunk,
    SessionStreamEvent,
    SessionView,
  } from "@atlas/core/session/session-events";
  import { initialSessionView, reduceSessionEvent } from "@atlas/core/session/session-reducer";
  import { experimental_streamedQuery } from "@tanstack/query-core";
  import { createQuery } from "@tanstack/svelte-query";
  import { IconSmall } from "$lib/components/icons/small";
  import AgentBlockCard from "$lib/components/session-history/agent-block-card.svelte";
  import { formatDuration, formatSessionDate } from "$lib/utils/date";
  import { sessionEventStream } from "$lib/utils/session-event-stream";
  import { onMount } from "svelte";
  import Breadcrumbs from "../(components)/breadcrumbs.svelte";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  const query = createQuery(() => ({
    queryKey: ["session-stream", data.sessionId],
    queryFn: experimental_streamedQuery<SessionStreamEvent | EphemeralChunk, SessionView>({
      streamFn: () => sessionEventStream(data.sessionId),
      reducer: reduceSessionEvent,
      initialValue: initialSessionView(),
    }),
  }));

  const session = $derived(query.data);
  const isLive = $derived(query.isFetching);
  const isOutdated = $derived(query.error?.message?.includes("outdated format") ?? false);

  const displayTitle = $derived(session?.task?.slice(0, 80) || session?.jobName || data.sessionId);
  const sessionDate = $derived(session?.startedAt ? formatSessionDate(session.startedAt) : "");
  const duration = $derived(session?.durationMs ? formatDuration(0, session.durationMs) : null);

  onMount(() => {
    trackEvent(GA4.SESSION_VIEW, {
      session_id: data.sessionId,
      session_status: session?.status ?? "unknown",
    });
  });
</script>

<Breadcrumbs session={{ id: data.sessionId, workspaceId: session?.workspaceId }} />

<div class="page">
  <div class="content">
    {#if query.isPending}
      <div class="loading">Loading session...</div>
    {:else if isOutdated}
      <div class="outdated">
        <IconSmall.Close />
        <p>This session uses an outdated storage format and cannot be displayed.</p>
      </div>
    {:else if query.isError}
      <div class="error-state">
        <p>Connection lost</p>
        <button class="retry-button" onclick={() => query.refetch()}>Retry</button>
      </div>
    {:else if session}
      <span
        class="status"
        class:completed={session.status === "completed"}
        class:failed={session.status === "failed"}
        class:active={session.status === "active" || isLive}
      >
        {#if session.status === "completed"}
          <IconSmall.Check />
          Complete
        {:else if session.status === "failed"}
          <IconSmall.Close />
          Failed
        {:else if isLive}
          <IconSmall.Progress />
          Running
        {:else}
          <IconSmall.Check />
          Complete
        {/if}
      </span>

      <h1>{displayTitle}</h1>

      <div class="meta">
        {#if sessionDate}
          <time title={session.startedAt} datetime={session.startedAt} class="session-date">
            {sessionDate}
          </time>
        {/if}
        {#if duration}
          <span class="duration">{duration}</span>
        {/if}
      </div>

      {#if session.error}
        <div class="session-error">
          <pre class="error-message">{session.error}</pre>
        </div>
      {/if}

      {#if session.aiSummary}
        <div class="summary-section">
          <h2 class="summary-heading">Summary</h2>
          <p class="summary-text">{session.aiSummary.summary}</p>
          {#if session.aiSummary.keyDetails.length > 0}
            <dl class="key-details">
              {#each session.aiSummary.keyDetails as detail (detail.label)}
                <div class="key-detail-row">
                  <dt>{detail.label}</dt>
                  <dd>
                    {#if detail.url}
                      <a href={detail.url} target="_blank" rel="noopener noreferrer">
                        {detail.value}
                      </a>
                    {:else}
                      {detail.value}
                    {/if}
                  </dd>
                </div>
              {/each}
            </dl>
          {/if}
        </div>
      {:else if isLive && session.status !== "active"}
        <div class="summary-section">
          <h2 class="summary-heading">Summary</h2>
          <div class="summary-skeleton">
            <div class="skeleton-line wide"></div>
            <div class="skeleton-line medium"></div>
          </div>
        </div>
      {/if}

      <div class="agent-blocks">
        {#each session.agentBlocks as block, i (i)}
          <AgentBlockCard {block} />
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  .page {
    block-size: 100%;
    inline-size: 100%;
    overflow: auto;
  }

  .content {
    margin-inline: auto;
    max-inline-size: 800px;
    padding-block: var(--size-12);
    padding-inline: var(--size-14);
  }

  h1 {
    font-size: var(--font-size-8);
    font-weight: var(--font-weight-7);
    line-height: var(--font-lineheight-1);
    margin-block: var(--size-3) var(--size-1);
  }

  .meta {
    align-items: center;
    display: flex;
    gap: var(--size-3);
  }

  .session-date {
    color: var(--color-text);
    font-size: var(--font-size-4);
    font-weight: var(--font-weight-5);
    line-height: var(--font-lineheight-1);
    opacity: 0.7;
  }

  .duration {
    color: var(--text-3);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-3);
  }

  .status {
    align-items: center;
    block-size: var(--size-5-5);
    border: 1px solid transparent;
    border-radius: var(--radius-2-5);
    color: var(--color-text-2);
    display: flex;
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    gap: var(--size-1);
    inline-size: fit-content;
    padding-inline: var(--size-1-5) var(--size-2);

    &.completed {
      background: color-mix(in srgb, var(--color-green) 7%, transparent);
      color: var(--color-green-2);
    }

    &.failed {
      background: color-mix(in srgb, var(--color-red) 7%, transparent);
      color: var(--color-red);
    }

    &.active {
      background: color-mix(in srgb, var(--color-yellow) 10%, transparent);
      color: var(--color-yellow-2);
    }
  }

  /* AI Summary */
  .summary-section {
    margin-block-start: var(--size-8);
  }

  .summary-heading {
    font-size: var(--font-size-5);
    font-weight: var(--font-weight-6);
    margin-block-end: var(--size-2);
  }

  .summary-text {
    color: var(--text-2);
    font-size: var(--font-size-3);
    line-height: var(--font-lineheight-3);
  }

  .key-details {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    margin-block-start: var(--size-3);
  }

  .key-detail-row {
    display: flex;
    gap: var(--size-2);
  }

  .key-detail-row dt {
    color: var(--text-3);
    flex-shrink: 0;
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-5);
    min-inline-size: var(--size-24);
  }

  .key-detail-row dd {
    font-size: var(--font-size-3);
  }

  .key-detail-row dd a {
    color: var(--color-blue);
    text-decoration: none;

    &:hover {
      text-decoration: underline;
    }
  }

  .summary-skeleton {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .skeleton-line {
    animation: pulse 1.5s ease-in-out infinite;
    background: var(--color-surface-1);
    block-size: var(--size-4);
    border-radius: var(--radius-1);
  }

  .skeleton-line.wide {
    inline-size: 90%;
  }

  .skeleton-line.medium {
    inline-size: 60%;
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 0.4;
    }
    50% {
      opacity: 0.8;
    }
  }

  .agent-blocks {
    display: flex;
    flex-direction: column;
    padding-block-start: var(--size-8);
  }

  .session-error {
    background-color: color-mix(in srgb, var(--color-red) 10%, transparent);
    border-inline-start: 3px solid var(--color-red);
    border-radius: var(--radius-1);
    margin-block-start: var(--size-6);
    padding-block: var(--size-2);
    padding-inline: var(--size-3);
  }

  .error-message {
    color: var(--color-red);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-2);
    line-height: var(--font-lineheight-3);
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .loading {
    color: var(--text-3);
    font-size: var(--font-size-4);
    padding-block-start: var(--size-8);
  }

  .outdated {
    align-items: center;
    color: var(--text-3);
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
    padding-block-start: var(--size-12);
    text-align: center;

    p {
      font-size: var(--font-size-4);
    }

    :global(svg) {
      block-size: 24px;
      color: var(--color-red);
      inline-size: 24px;
    }
  }

  .error-state {
    align-items: center;
    display: flex;
    flex-direction: column;
    gap: var(--size-4);
    padding-block-start: var(--size-12);
    text-align: center;

    p {
      color: var(--text-3);
      font-size: var(--font-size-4);
    }
  }

  .retry-button {
    background-color: var(--color-surface-1);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    color: var(--color-text);
    cursor: pointer;
    font-size: var(--font-size-3);
    padding-block: var(--size-2);
    padding-inline: var(--size-4);

    &:hover {
      background-color: var(--color-highlight-1);
    }
  }
</style>
