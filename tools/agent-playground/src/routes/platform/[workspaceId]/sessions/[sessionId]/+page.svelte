<script lang="ts">
  import type {
    EphemeralChunk,
    SessionStreamEvent,
    SessionView,
  } from "@atlas/core/session/session-events";
  import {
    initialSessionView,
    reduceSessionEvent,
  } from "@atlas/core/session/session-reducer";
  import { Button, FormattedData, Icons, IconSmall, JsonHighlight, StatusBadge } from "@atlas/ui";
  import { experimental_streamedQuery } from "@tanstack/query-core";
  import { createQuery } from "@tanstack/svelte-query";
  import { tick } from "svelte";
  import { page } from "$app/state";
  import { AgentBlockCard, parseError, StepBlock } from "$lib/components/session";
  import WorkspaceBreadcrumb from "$lib/components/workspace-breadcrumb.svelte";
  import { formatDuration, formatSessionDate } from "$lib/utils/date";
  import { sessionEventStream } from "$lib/utils/session-event-stream";

  const sessionId = $derived(page.params.sessionId);
  const workspaceId = $derived(page.params.workspaceId);

  /** Hash fragment target block ID (e.g. "block-step_clone_repo") */
  const hashTarget = $derived(
    typeof window !== "undefined" && window.location.hash
      ? window.location.hash.slice(1)
      : null,
  );

  const query = createQuery<SessionView>(() => ({
    queryKey: ["session-detail", sessionId],
    queryFn: experimental_streamedQuery<
      SessionStreamEvent | EphemeralChunk,
      SessionView
    >({
      streamFn: () => sessionEventStream(sessionId),
      reducer: reduceSessionEvent,
      initialValue: initialSessionView(),
    }),
  }));

  const isFinished = $derived(
    query.data?.status === "completed" || query.data?.status === "failed",
  );
  const duration = $derived(
    query.data?.durationMs ? formatDuration(0, query.data.durationMs) : null,
  );
  const sessionDate = $derived(
    query.data?.startedAt ? formatSessionDate(query.data.startedAt) : "",
  );

  /** Scroll to hash-targeted block once data has loaded. */
  let hasScrolled = $state(false);
  $effect(() => {
    if (!hashTarget || hasScrolled || !query.data || query.data.agentBlocks.length === 0) return;
    // Wait for DOM to render
    tick().then(() => {
      const el = document.getElementById(hashTarget);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        hasScrolled = true;
      }
    });
  });
</script>

<div class="session-detail">
  <div class="main">
    <WorkspaceBreadcrumb {workspaceId} section="Runs" />

    {#if query.isPending}
      <div class="loading">Loading run...</div>
    {:else if query.isError}
      <div class="error-state">
        <p>Failed to load run</p>
        <Button size="small" variant="secondary" onclick={() => query.refetch()}>Retry</Button>
      </div>
    {:else if query.data}
      <header class="session-header">
        <div class="title-row">
          <h1>{query.data.jobName || sessionId}</h1>
          {#if query.data.status !== "completed"}
            <StatusBadge status={query.isFetching ? "active" : query.data.status} />
          {/if}
        </div>

        {#if query.isFetching && !isFinished}
          <p class="session-subtitle">This run is in progress</p>
        {:else if query.data.aiSummary}
          <p class="session-subtitle">{query.data.aiSummary.summary}</p>
        {/if}
      </header>

      <p class="session-meta">
        {#if sessionDate}
          <time title={query.data.startedAt} datetime={query.data.startedAt}>
            {sessionDate}
          </time>
        {/if}
        {#if duration}
          <span class="meta-dot">&middot;</span>
          <span>{duration}</span>
        {/if}
      </p>

      {#if query.data.error && !query.data.aiSummary}
        <div class="session-error">
          <pre class="error-message">{query.data.error}</pre>
        </div>
      {/if}

      <div class="timeline">
        {#each query.data.agentBlocks as block, i (i)}
          <AgentBlockCard
            {block}
            defaultOpen={!query.isFetching || block.status === "running" || (hashTarget != null && block.stateId != null && hashTarget === `block-${block.stateId}`)}
          />
        {/each}
        {#if isFinished}
          {@const resultTitle = query.data.status === "completed" ? "Complete" : "Failed"}
          {@const resultSubtitle =
            query.data.status === "completed" && duration
              ? `Succeeded in ${duration}`
              : query.data.status === "failed" && duration
                ? `After ${duration}`
                : undefined}
          {@const sessionError = query.data.error ? parseError(query.data.error) : null}
          <StepBlock.Root>
            {#snippet header()}
              <StepBlock.Header title={resultTitle} subtitle={resultSubtitle}>
                {#snippet fallbackIcon()}
                  {#if sessionError}
                    <span style:color="var(--color-red)">
                      <Icons.Close />
                    </span>
                  {:else}
                    <span style:color="var(--color-green)">
                      <Icons.DotFilled />
                    </span>
                  {/if}
                {/snippet}
              </StepBlock.Header>
            {/snippet}
            {#if sessionError}
              {#if "prefix" in sessionError}
                <p class="error-label">{sessionError.prefix}</p>
                <FormattedData variant="error" copyText={sessionError.reason} maxLines={7}>
                  <p>{sessionError.reason}</p>
                </FormattedData>
              {:else}
                <FormattedData variant="error" copyText={sessionError.raw} maxLines={7}>
                  <pre>{sessionError.raw}</pre>
                </FormattedData>
              {/if}
            {:else if query.data.results && Object.keys(query.data.results).length > 0}
              <FormattedData copyText={JSON.stringify(query.data.results, null, 2)} maxLines={7}>
                <JsonHighlight code={JSON.stringify(query.data.results, null, 2)} />
              </FormattedData>
            {/if}
          </StepBlock.Root>
        {/if}
      </div>
    {/if}
  </div>

  {#if query.data}
    <aside class="detail-sidebar">
      <div class="sidebar-section">
        <h3>Job</h3>
        <p class="job-name">{query.data.jobName}</p>
        <p class="workspace-id">{query.data.workspaceId}</p>
      </div>

      {#if query.data.aiSummary?.keyDetails && query.data.aiSummary.keyDetails.length > 0}
        <div class="sidebar-section">
          <h3>Summary</h3>
          <dl class="key-details">
            {#each query.data.aiSummary.keyDetails as detail (detail.label)}
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
        </div>
      {/if}

      <div class="sidebar-section">
        <h3>Details</h3>
        <dl class="key-details">
          <div class="key-detail-row">
            <dt>Run ID</dt>
            <dd class="mono">{query.data.sessionId}</dd>
          </div>
          <div class="key-detail-row">
            <dt>Status</dt>
            <dd>{query.data.status}</dd>
          </div>
          {#if query.data.startedAt}
            <div class="key-detail-row">
              <dt>Started</dt>
              <dd>{formatSessionDate(query.data.startedAt)}</dd>
            </div>
          {/if}
          {#if duration}
            <div class="key-detail-row">
              <dt>Duration</dt>
              <dd>{duration}</dd>
            </div>
          {/if}
          {#if query.data.agentBlocks.length > 0}
            <div class="key-detail-row">
              <dt>Steps</dt>
              <dd>{query.data.agentBlocks.length}</dd>
            </div>
          {/if}
        </dl>
      </div>
    </aside>
  {/if}
</div>

<style>
  .session-detail {
    display: grid;
    grid-template-columns: 1fr;
    block-size: 100%;
    overflow: hidden;

    &:has(.detail-sidebar) {
      grid-template-columns: 1fr var(--size-72);
    }
  }

  .main {
    display: flex;
    flex-direction: column;
    gap: var(--size-6);
    overflow: auto;
    padding: var(--size-8) var(--size-10);
    scrollbar-width: thin;
  }

  .session-header {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);

    h1 {
      font-size: var(--font-size-7);
      font-weight: var(--font-weight-6);
    }
  }

  .title-row {
    align-items: center;
    display: flex;
    gap: var(--size-3);
  }

  .session-subtitle {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-3);
    line-height: var(--font-lineheight-3);
    max-inline-size: 60ch;
  }

  .session-meta {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    display: flex;
    font-size: var(--font-size-2);
    gap: var(--size-1-5);
  }

  .meta-dot {
    opacity: 0.4;
  }

  .session-error {
    background-color: color-mix(in srgb, var(--color-red) 10%, transparent);
    border-inline-start: 3px solid var(--color-red);
    border-radius: var(--radius-1);
    padding-block: var(--size-2);
    padding-inline: var(--size-3);
  }

  .error-message {
    color: var(--color-red);
    font-family: var(--font-mono);
    font-size: var(--font-size-2);
    line-height: var(--font-lineheight-3);
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .error-label {
    color: var(--color-red);
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-5);
  }

  .timeline {
    display: flex;
    flex-direction: column;
    padding-block-start: var(--size-2);
  }

  .loading {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-4);
    padding-block-start: var(--size-8);
  }

  .error-state {
    align-items: center;
    display: flex;
    flex-direction: column;
    gap: var(--size-4);
    padding-block-start: var(--size-12);
    text-align: center;

    p {
      color: color-mix(in srgb, var(--color-text), transparent 50%);
      font-size: var(--font-size-4);
    }
  }

  .detail-sidebar {
    border-inline-start: var(--size-px) solid var(--color-border-1);
    display: flex;
    flex-direction: column;
    gap: var(--size-8);
    overflow: auto;
    padding: var(--size-8) var(--size-6);
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

  .workspace-id {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-2);
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
  }

  .mono {
    font-family: var(--font-mono);
    font-size: var(--font-size-1);
    word-break: break-all;
  }
</style>
