<script lang="ts">
  import { IconSmall } from "$lib/components/icons/small";
  import MarkdownContent from "$lib/components/primitives/markdown-content.svelte";
  import TimelineMain from "$lib/components/session-timeline/timeline-main.svelte";
  import { GA4, trackEvent } from "@atlas/ga4";
  import { formatSessionDate } from "$lib/utils/date";
  import { page } from "$app/state";
  import { onMount } from "svelte";
  import Breadcrumbs from "../(components)/breadcrumbs.svelte";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();
  const spaceId = $derived(page.params.id);

  const session = $derived(data.session);
  const sessionDate = $derived(formatSessionDate(session.createdAt));
  const isTask = $derived(session.type === "task");

  // Extract meaningful title: prefer title, then truncated task/summary
  const displayTitle = $derived(
    session.title ??
      session.input?.task?.slice(0, 80) ??
      session.summary?.slice(0, 80) ??
      session.id,
  );

  // Get task description from input
  const taskDescription = $derived(session.input?.task ?? session.summary);

  // Use pre-computed fields from digest
  const outputContent = $derived(session.outputContent);
  const artifacts = $derived(session.artifacts);
  const primaryError = $derived(session.primaryError);

  // Show either LLM output or error for failed sessions
  const hasOutput = $derived(outputContent !== undefined || primaryError !== undefined);

  onMount(() => {
    trackEvent(GA4.SPACE_SESSION_VIEW, { space_id: spaceId, session_id: session.id, session_status: session.status });
  });
</script>

<Breadcrumbs {session} workspaceName={session.workspaceName} />

<div class="page">
  <div class="content">
    <span
      class="status"
      class:completed={session.status === "completed"}
      class:failed={session.status === "failed"}
      class:pending={session.status === "partial"}
    >
      {#if session.status === "completed"}
        <IconSmall.Check />
        Complete
      {:else if session.status === "failed"}
        <IconSmall.Close />
        Failed
      {:else if session.status === "partial"}
        <IconSmall.Progress />
        In Progress
      {/if}
    </span>

    <h1>{displayTitle}</h1>

    <div class="meta">
      <time title={session.createdAt} datetime={session.createdAt} class="session-date">
        {sessionDate}
      </time>
    </div>

    <div class="details">
      <h2>Task</h2>
      <p>{taskDescription}</p>

      {#if hasOutput}
        <h2>Output</h2>
        {#if outputContent}
          <div class="output-content">
            <MarkdownContent content={outputContent} />
          </div>
        {:else if primaryError}
          <div class="output-error">
            <pre class="error-message">{primaryError}</pre>
          </div>
        {/if}
      {/if}

      <h2>Steps</h2>
      <TimelineMain steps={session.steps} fallbackTask={session.input?.task} />
    </div>
  </div>

  <aside class="sidebar">
    {#if artifacts.length > 0}
      <div class="sidebar-section">
        <span class="sidebar-label">Artifacts</span>
        <ul class="sidebar-list">
          {#each artifacts as artifact (artifact.id)}
            <li>
              <a
                href="/library/{artifact.id}"
                class="sidebar-item"
                onclick={() => trackEvent(GA4.SPACE_SESSION_ARTIFACT_CLICK, { space_id: spaceId, session_id: session.id, artifact_id: artifact.id })}
              >
                <IconSmall.File />
                <span class="item-text">{artifact.title ?? "Untitled"}</span>
              </a>
            </li>
          {/each}
        </ul>
      </div>
    {/if}

    {#if isTask && session.parentStreamId}
      <div class="sidebar-section">
        <span class="sidebar-label">Chat</span>
        <ul class="sidebar-list">
          <li>
            <a
              href="/chat/{session.parentStreamId}"
              class="sidebar-item"
              onclick={() =>
                trackEvent(GA4.SPACE_SESSION_CHAT_LINK_CLICK, { space_id: spaceId, session_id: session.id, chat_id: session.parentStreamId! })}
            >
              <span class="item-text">{session.parentTitle ?? "Conversation"}</span>
            </a>
          </li>
        </ul>
      </div>
    {/if}
  </aside>
</div>

<style>
  .page {
    display: grid;
    grid-template-columns: 1fr var(--size-56);
    block-size: 100%;
    inline-size: 100%;
    gap: var(--size-6);
    overflow: auto;
  }

  .content {
    flex: 1;
    padding-block: var(--size-12);
    padding-inline: var(--size-14);
    overflow-y: auto;
    scrollbar-width: thin;
  }

  h1 {
    font-size: var(--font-size-8);
    font-weight: var(--font-weight-7);
    margin-block: var(--size-3) var(--size-1);
    line-height: var(--font-lineheight-1);
  }

  .meta {
    align-items: center;
    display: flex;
    gap: var(--size-2);
  }

  .session-date {
    color: var(--color-text);
    font-size: var(--font-size-4);
    font-weight: var(--font-weight-5);
    line-height: var(--font-lineheight-1);
    opacity: 0.7;
  }

  .status {
    align-items: center;
    border-radius: var(--radius-2-5);
    border: 1px solid transparent;
    block-size: var(--size-5-5);
    color: var(--color-text-2);
    display: flex;
    gap: var(--size-1);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
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

    &.pending {
      background: color-mix(in srgb, var(--color-yellow) 10%, transparent);
      color: var(--color-yellow-2);
    }
  }

  .details {
    padding-block-start: var(--size-10);

    h2 {
      font-size: var(--font-size-4);
      font-weight: var(--font-weight-5);
      line-height: var(--font-lineheight-1);
      opacity: 0.7;

      &:not(:first-child) {
        margin-block-start: var(--size-8);
      }
    }

    p {
      font-size: var(--font-size-4);
      opacity: 0.8;
      padding-block-start: var(--size-1);
    }
  }

  .output-content {
    background-color: var(--color-surface-1);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-3);
    margin-block-start: var(--size-3);
    padding-block: var(--size-4);
    padding-inline: var(--size-5);
  }

  .output-error {
    background-color: color-mix(in srgb, var(--color-red) 10%, transparent);
    border-inline-start: 3px solid var(--color-red);
    border-radius: var(--radius-1);
    margin-block-start: var(--size-3);
    padding-block: var(--size-2);
    padding-inline: var(--size-3);
  }

  .error-message {
    color: var(--color-red);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-2);
    line-height: var(--font-lineheight-3);
    white-space: pre-wrap;
    word-break: break-word;
    margin: 0;
  }

  /* Sidebar styles - matching chat sidebar pattern */
  .sidebar {
    display: flex;
    flex-direction: column;
    gap: 0;
    inline-size: 228px;
    padding-block: var(--size-12);
    padding-inline: 0 var(--size-6);
    position: sticky;
    inset-block-start: 0;
    align-self: start;
  }

  .sidebar-section {
    display: flex;
    flex-direction: column;
  }

  .sidebar-label {
    border-block-start: var(--size-px) solid var(--color-border-1);
    block-size: var(--size-9);
    display: flex;
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-4-5);
    padding-block: var(--size-3) var(--size-1-5);
    padding-inline: var(--size-2-5);
  }

  .sidebar-list {
    display: flex;
    flex-direction: column;
    padding-block-end: var(--size-2);
    list-style: none;
    margin: 0;
    padding-inline: 0;

    li {
      inline-size: 100%;
    }
  }

  .sidebar-item {
    align-items: center;
    block-size: var(--size-7);
    border-radius: var(--radius-2);
    color: var(--color-text);
    display: flex;
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-4-5);
    gap: var(--size-2);
    padding-inline: var(--size-2-5) var(--size-2);
    text-decoration: none;
    outline: none;

    & :global(svg) {
      color: var(--accent-1);
      flex: none;
      opacity: 0.5;
    }

    &:hover,
    &:focus-visible {
      background-color: var(--color-highlight-1);
    }
  }

  .item-text {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    opacity: 0.8;
  }
</style>
