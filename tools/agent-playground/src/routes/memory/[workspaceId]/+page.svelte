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

  const enrichedQuery = createQuery(() => workspaceQueries.enriched());

  const COLORS: Record<string, string> = {
    yellow: "var(--yellow-2, #facc15)",
    purple: "var(--purple-2, #a78bfa)",
    red: "var(--red-2, #f87171)",
    blue: "var(--blue-2, #60a5fa)",
    green: "var(--green-2, #4ade80)",
    brown: "var(--brown-2, #a3824a)",
  };

  const nameMap = $derived.by(() => {
    const map = new Map<string, string>();
    for (const ws of enrichedQuery.data ?? []) {
      map.set(ws.id, ws.displayName);
    }
    return map;
  });

  const colorMap = $derived.by(() => {
    const map = new Map<string, string>();
    for (const ws of enrichedQuery.data ?? []) {
      const key = ws.metadata?.color ?? "yellow";
      map.set(ws.id, COLORS[key] ?? COLORS["yellow"] ?? "#facc15");
    }
    return map;
  });

  const memoriesQuery = createQuery(() => ({
    ...memoryQueries.memories(workspaceId),
    enabled: workspaceId.length > 0,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  }));

  const narrativeMemories = $derived(
    (memoriesQuery.data ?? []).filter((c) => c.kind === "narrative"),
  );

  // $derived is required: Svelte 5 {#if} blocks don't re-evaluate when
  // @tanstack/svelte-query's proxy-based state changes without an explicit derived.
  const isMemoriesLoading = $derived(memoriesQuery.isLoading);
  const memoriesError = $derived(memoriesQuery.error);

  /** Convert a slug like `autopilot-backlog` → `Autopilot Backlog`. */
  function humanize(slug: string): string {
    return slug
      .split("-")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  }
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

  {#if isMemoriesLoading}
    <div class="loading">Loading memories…</div>
  {:else if memoriesError}
    <div class="error-banner">
      <span>Failed to load memories: {memoriesError.message}</span>
      <button class="dismiss" onclick={() => memoriesQuery.refetch()}>Retry</button>
    </div>
  {:else if narrativeMemories.length === 0}
    <div class="empty">No narrative memories found in {workspaceName}.</div>
  {:else}
    <ul class="card-list">
      {#each narrativeMemories as memory (`${memory.workspaceId}/${memory.name}`)}
        {@const isMounted = memory.workspaceId !== workspaceId}
        {@const sourceName = nameMap.get(memory.workspaceId) ?? memory.workspaceId}
        {@const dotColor = colorMap.get(memory.workspaceId)}
        <li>
          <a
            href="/memory/{encodeURIComponent(memory.workspaceId)}/{encodeURIComponent(memory.name)}"
            class="memory-card"
            class:is-mounted={isMounted}
          >
            <span class="ws-dot" style:--dot-color={dotColor}></span>
            <span class="memory-name">{humanize(memory.name)}</span>
            <span class="card-right">
              {#if isMounted}
                <span class="mount-source">from {sourceName}</span>
              {/if}
              <span class="memory-kind">{memory.name}</span>
            </span>
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

    &.is-mounted {
      border-style: dashed;
    }
  }

  .ws-dot {
    background: var(--dot-color, var(--yellow-2, #facc15));
    block-size: 8px;
    border-radius: 50%;
    flex-shrink: 0;
    inline-size: 8px;
  }

  .memory-name {
    flex: 1;
    font-family: var(--font-mono);
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-5);
  }

  .card-right {
    align-items: center;
    display: flex;
    gap: var(--size-2);
  }

  .mount-source {
    color: color-mix(in srgb, var(--color-text), transparent 45%);
    font-size: var(--font-size-1);
  }

  .memory-kind {
    background: var(--color-surface-3);
    border-radius: var(--radius-1);
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-size: var(--font-size-1);
    padding: 1px var(--size-1-5);
  }
</style>
