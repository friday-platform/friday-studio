<script lang="ts">
  // CLAUDE.md gotcha: never call goto() from $effect — invisible infinite
  // navigation loops hang the browser. The previous version used $effect to
  // redirect on ?ws=foo. Replaced with a plain anchor in the empty-state UI
  // that the user clicks if they arrived with a query param. Same UX, no
  // navigation loop. See docs/never-again/2026-04-02-effect-goto-loops.md
  import { createQuery } from "@tanstack/svelte-query";
  import { memoryQueries, workspaceQueries } from "$lib/queries";

  const workspacesQuery = createQuery(() => memoryQueries.workspaces());
  const enrichedQuery = createQuery(() => workspaceQueries.enriched());

  const COLORS: Record<string, string> = {
    yellow: "var(--yellow-2, #facc15)",
    purple: "var(--purple-2, #a78bfa)",
    red: "var(--red-2, #f87171)",
    blue: "var(--blue-2, #60a5fa)",
    green: "var(--green-2, #4ade80)",
    brown: "var(--brown-2, #a3824a)",
  };

  /** Map workspace ID → display name (config name > daemon name > id). */
  const nameMap = $derived.by(() => {
    const map = new Map<string, string>();
    for (const ws of enrichedQuery.data ?? []) {
      map.set(ws.id, ws.displayName);
    }
    return map;
  });

  /** Map workspace ID → dot color matching the sidebar. */
  const colorMap = $derived.by(() => {
    const map = new Map<string, string>();
    for (const ws of enrichedQuery.data ?? []) {
      const key = ws.metadata?.color ?? "yellow";
      map.set(ws.id, COLORS[key] ?? COLORS["yellow"] ?? "#facc15");
    }
    return map;
  });

  const allWorkspaces = $derived(workspacesQuery.data ?? []);

  const mounted = $derived(allWorkspaces.filter((id) => nameMap.has(id)));
  const unmounted = $derived(allWorkspaces.filter((id) => !nameMap.has(id)));

  type Tab = "mounted" | "unmounted";
  let activeTab = $state<Tab>("mounted");

  const visible = $derived(activeTab === "mounted" ? mounted : unmounted);
</script>

<div class="memory-root">
  <header class="page-header">
    <h1>Memory</h1>
    <p class="subtitle">Browse workspace memories</p>
  </header>

  {#if workspacesQuery.isLoading || enrichedQuery.isLoading}
    <div class="loading">Loading workspaces…</div>
  {:else if workspacesQuery.error}
    <div class="error-banner">
      <span>Failed to load workspaces: {workspacesQuery.error.message}</span>
      <button class="dismiss" onclick={() => workspacesQuery.refetch()}>Retry</button>
    </div>
  {:else}
    <div class="tab-bar">
      <button
        class="tab"
        class:active={activeTab === "mounted"}
        onclick={() => (activeTab = "mounted")}
      >
        Workspaces
        {#if mounted.length > 0}<span class="badge">{mounted.length}</span>{/if}
      </button>
      <button
        class="tab"
        class:active={activeTab === "unmounted"}
        onclick={() => (activeTab = "unmounted")}
      >
        Unmounted
        {#if unmounted.length > 0}<span class="badge muted">{unmounted.length}</span>{/if}
      </button>
    </div>

    {#if visible.length === 0}
      <div class="empty">
        {activeTab === "mounted"
          ? "No active workspaces with memories."
          : "No orphaned memories found."}
      </div>
    {:else}
      <ul class="workspace-list">
        {#each visible as wsId (wsId)}
          {@const displayName = nameMap.get(wsId) ?? wsId}
          {@const dotColor = colorMap.get(wsId)}
          <li>
            <a href="/memory/{encodeURIComponent(wsId)}" class="workspace-card">
              <span
                class="ws-dot"
                class:muted={activeTab === "unmounted"}
                style:--dot-color={dotColor}
              ></span>
              <span class="ws-name">{displayName}</span>
              {#if activeTab === "unmounted"}
                <span class="ws-id">{wsId}</span>
              {/if}
            </a>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</div>

<style>
  .memory-root {
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

  .page-header h1 {
    font-size: var(--font-size-6);
    font-weight: var(--font-weight-7);
  }

  .subtitle {
    color: color-mix(in srgb, var(--color-text), transparent 35%);
    font-size: var(--font-size-2);
  }

  .tab-bar {
    display: flex;
    gap: var(--size-1);
    border-block-end: 1px solid var(--color-border-1);
  }

  .tab {
    all: unset;
    align-items: center;
    border-block-end: 2px solid transparent;
    color: color-mix(in srgb, var(--color-text), transparent 45%);
    cursor: pointer;
    display: flex;
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    gap: var(--size-1-5);
    margin-block-end: -1px;
    padding: var(--size-2) var(--size-1);
    transition: color 120ms ease;

    &:hover {
      color: var(--color-text);
    }

    &.active {
      border-color: var(--color-accent, #1171df);
      color: var(--color-text);
    }
  }

  .badge {
    background: color-mix(in srgb, var(--color-accent, #1171df), transparent 80%);
    border-radius: var(--radius-round);
    color: var(--color-accent, #1171df);
    font-size: var(--font-size-0);
    font-weight: var(--font-weight-6);
    min-inline-size: var(--size-4);
    padding-inline: var(--size-1);
    text-align: center;

    &.muted {
      background: color-mix(in srgb, var(--color-text), transparent 88%);
      color: color-mix(in srgb, var(--color-text), transparent 30%);
    }
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

  .workspace-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .workspace-card {
    align-items: center;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    color: var(--color-text);
    display: flex;
    gap: var(--size-2);
    padding: var(--size-3) var(--size-4);
    text-decoration: none;
    transition: background 100ms ease;

    &:hover {
      background: var(--color-surface-3);
    }
  }

  .ws-dot {
    background: var(--dot-color, var(--yellow-2, #facc15));
    block-size: 8px;
    border-radius: 50%;
    flex-shrink: 0;
    inline-size: 8px;

    &.muted {
      background: color-mix(in srgb, var(--color-text), transparent 60%);
    }
  }

  .ws-name {
    flex: 1;
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-5);
  }

  .ws-id {
    color: color-mix(in srgb, var(--color-text), transparent 45%);
    font-family: var(--font-mono);
    font-size: var(--font-size-1);
  }
</style>
