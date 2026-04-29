<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import { page } from "$app/state";
  import MemoryEntryTable from "$lib/components/MemoryEntryTable.svelte";
  import { memoryQueries, workspaceQueries } from "$lib/queries";
  import type { NarrativeEntry } from "$lib/api/memory.ts";

  const workspaceId = $derived(page.params.workspaceId ?? "");
  const memoryName = $derived(page.params.memoryName ?? "");
  const configQuery = createQuery(() => workspaceQueries.config(workspaceId || null));
  const workspaceName = $derived(
    (configQuery.data?.config?.workspace as Record<string, unknown> | undefined)?.name as string | undefined
      ?? workspaceId,
  );

  const entriesQuery = createQuery(() => ({
    ...memoryQueries.narrativeEntries(workspaceId, memoryName),
    enabled: workspaceId.length > 0 && memoryName.length > 0,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  }));

  const rawEntries = $derived(entriesQuery.data ?? []);

  // Narrative memory is append-only — same id can have multiple entries
  // reflecting status transitions (pending → completed, etc). Default to
  // the dedupe view so the UI matches what the planner and improvements
  // inbox actually see. Toggle to raw for audit-trail debugging.
  let showAllHistory = $state(false);

  const entries = $derived.by<NarrativeEntry[]>(() => {
    if (showAllHistory) return rawEntries;
    const latest = new Map<string, NarrativeEntry>();
    for (const entry of rawEntries) {
      const prior = latest.get(entry.id);
      if (!prior || entry.createdAt > prior.createdAt) {
        latest.set(entry.id, entry);
      }
    }
    return [...latest.values()].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  });

  const duplicateCount = $derived(rawEntries.length - new Set(rawEntries.map((e) => e.id)).size);

  const lastUpdated = $derived.by(() => {
    if (!entriesQuery.dataUpdatedAt) return null;
    return new Date(entriesQuery.dataUpdatedAt).toLocaleTimeString();
  });

  // $derived is required: Svelte 5 {#if} blocks don't re-evaluate when
  // @tanstack/svelte-query's proxy-based state changes without an explicit derived.
  const isEntriesLoading = $derived(entriesQuery.isLoading);
  const isFetchingEntries = $derived(entriesQuery.isFetching);
  const entriesError = $derived(entriesQuery.error);

  function handleKeydown(e: KeyboardEvent) {
    const target = e.target;
    if (target instanceof HTMLInputElement) return;
    if (target instanceof HTMLTextAreaElement) return;
    if (target instanceof HTMLSelectElement) return;
    if (target instanceof HTMLElement && target.isContentEditable) return;

    if (e.key === "r" || e.key === "R") {
      e.preventDefault();
      entriesQuery.refetch();
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="memory-detail">
  <header class="page-header">
    <nav class="breadcrumb">
      <a href="/memory">Memory</a>
      <span class="sep">/</span>
      <a href="/memory/{encodeURIComponent(workspaceId)}">{workspaceName}</a>
      <span class="sep">/</span>
      <span>{memoryName}</span>
    </nav>

    <div class="title-row">
      <h1>{memoryName}</h1>
      {#if isFetchingEntries}
        <span class="live-dot" title="Refreshing…"></span>
        <span class="live-label">Live</span>
      {/if}
    </div>

    <div class="meta-row">
      {#if lastUpdated}
        <span class="updated">Updated: {lastUpdated}</span>
      {/if}
      <span class="updated">
        {entries.length} {showAllHistory ? "raw" : "unique"} entries
        {#if !showAllHistory && duplicateCount > 0}
          <span class="hint">({duplicateCount} shadowed)</span>
        {/if}
      </span>
      <label class="history-toggle">
        <input type="checkbox" bind:checked={showAllHistory} />
        Show all history
      </label>
      <span class="hint">Press R to refresh</span>
    </div>
  </header>

  {#if entriesError && entries.length === 0}
    <div class="error-banner">
      <span>{entriesQuery.error?.message}</span>
      <button class="dismiss" onclick={() => entriesQuery.refetch()}>Retry</button>
    </div>
  {/if}

  <div class="table-container">
    <MemoryEntryTable {entries} loading={isEntriesLoading} />
  </div>
</div>

<style>
  .memory-detail {
    display: flex;
    flex-direction: column;
    block-size: 100%;
    min-block-size: 0;
  }

  .page-header {
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    gap: var(--size-1);
    padding: var(--size-5) var(--size-6) var(--size-3);
  }

  .breadcrumb {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-1);
  }

  .breadcrumb a {
    color: inherit;
    text-decoration: underline;
    text-underline-offset: 2px;

    &:hover {
      color: var(--color-text);
    }
  }

  .sep {
    margin-inline: var(--size-1);
  }

  .title-row {
    align-items: center;
    display: flex;
    gap: var(--size-2);
  }

  .title-row h1 {
    font-family: var(--font-mono);
    font-size: var(--font-size-6);
    font-weight: var(--font-weight-7);
  }

  .live-dot {
    animation: pulse 1.5s ease-in-out infinite;
    background: var(--color-success, var(--green-2, #4ade80));
    block-size: 8px;
    border-radius: 50%;
    inline-size: 8px;
  }

  .live-label {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.4;
    }
  }

  .meta-row {
    align-items: center;
    display: flex;
    gap: var(--size-3);
  }

  .updated {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-1);
  }

  .hint {
    color: color-mix(in srgb, var(--color-text), transparent 60%);
    font-size: var(--font-size-1);
  }

  .history-toggle {
    align-items: center;
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    cursor: pointer;
    display: flex;
    font-size: var(--font-size-1);
    gap: var(--size-1);
  }

  .history-toggle input {
    cursor: pointer;
  }

  .error-banner {
    align-items: center;
    background: color-mix(in srgb, var(--color-error, #ef4444), transparent 90%);
    border-radius: var(--radius-2);
    display: flex;
    gap: var(--size-3);
    justify-content: space-between;
    margin-inline: var(--size-6);
    padding: var(--size-3) var(--size-4);
  }

  .error-banner span {
    color: var(--color-text);
    font-size: var(--font-size-2);
  }

  .dismiss {
    background: none;
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    color: var(--color-text);
    cursor: pointer;
    font-size: var(--font-size-1);
    padding: var(--size-1) var(--size-2);
  }

  .table-container {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-block-size: 0;
    overflow: hidden;
  }
</style>
