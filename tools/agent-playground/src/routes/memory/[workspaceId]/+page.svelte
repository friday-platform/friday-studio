<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import { page } from "$app/state";
  import { memoryQueries, workspaceQueries } from "$lib/queries";

  const workspaceId = $derived(page.params.workspaceId ?? "");
  const configQuery = createQuery(() => workspaceQueries.config(workspaceId || null));
  const workspaceName = $derived(
    (configQuery.data?.config?.workspace as Record<string, unknown> | undefined)?.name as string | undefined
      ?? workspaceId,
  );

  const memoriesQuery = createQuery(() => ({
    ...memoryQueries.memories(workspaceId),
    enabled: workspaceId.length > 0,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  }));

  const narrativeMemories = $derived(
    (memoriesQuery.data ?? []).filter((c) => c.kind === "narrative"),
  );
</script>

<div class="memory-list">
  <header class="page-header">
    <nav class="breadcrumb">
      <a href="/memory">Memory</a>
      <span class="sep">/</span>
      <span>{workspaceName}</span>
    </nav>
    <h1>{workspaceName}</h1>
    <p class="subtitle">Narrative memories in this workspace</p>
  </header>

  {#if memoriesQuery.isLoading}
    <div class="loading">Loading memories…</div>
  {:else if memoriesQuery.error}
    <div class="error-banner">
      <span>Failed to load memories: {memoriesQuery.error.message}</span>
      <button class="dismiss" onclick={() => memoriesQuery.refetch()}>Retry</button>
    </div>
  {:else if narrativeMemories.length === 0}
    <div class="empty">No narrative memories found in {workspaceId}.</div>
  {:else}
    <ul class="card-list">
      {#each narrativeMemories as memory (memory.name)}
        <li>
          <a
            href="/memory/{encodeURIComponent(workspaceId)}/{encodeURIComponent(memory.name)}"
            class="memory-card"
          >
            <span class="memory-name">{memory.name}</span>
            <span class="memory-kind">{memory.kind}</span>
          </a>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .memory-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-6);
    max-inline-size: 640px;
    margin-inline: auto;
    padding: var(--size-10) var(--size-6);
  }

  .page-header {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
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

  .page-header h1 {
    font-family: var(--font-mono);
    font-size: var(--font-size-6);
    font-weight: var(--font-weight-7);
  }

  .subtitle {
    color: color-mix(in srgb, var(--color-text), transparent 35%);
    font-size: var(--font-size-2);
  }

  .loading,
  .empty {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-2);
    padding: var(--size-6);
    text-align: center;
  }

  .error-banner {
    align-items: center;
    background: color-mix(in srgb, var(--color-error, #ef4444), transparent 90%);
    border-radius: var(--radius-2);
    display: flex;
    gap: var(--size-3);
    justify-content: space-between;
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

  .card-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .memory-card {
    align-items: center;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    color: var(--color-text);
    display: flex;
    gap: var(--size-3);
    justify-content: space-between;
    padding: var(--size-3) var(--size-4);
    text-decoration: none;
    transition: background 100ms ease;

    &:hover {
      background: var(--color-surface-3);
    }
  }

  .memory-name {
    font-family: var(--font-mono);
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-5);
  }

  .memory-kind {
    background: var(--color-surface-3);
    border-radius: var(--radius-1);
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-size: var(--font-size-1);
    padding: 1px var(--size-1-5);
  }
</style>
