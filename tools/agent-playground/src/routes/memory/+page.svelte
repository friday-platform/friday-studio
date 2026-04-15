<script lang="ts">
  // CLAUDE.md gotcha: never call goto() from $effect — invisible infinite
  // navigation loops hang the browser. The previous version used $effect to
  // redirect on ?ws=foo. Replaced with a plain anchor in the empty-state UI
  // that the user clicks if they arrived with a query param. Same UX, no
  // navigation loop. See docs/never-again/2026-04-02-effect-goto-loops.md
  import { createQuery } from "@tanstack/svelte-query";
  import { memoryQueries } from "$lib/queries";

  const workspacesQuery = createQuery(() => memoryQueries.workspaces());
  const workspaces = $derived(workspacesQuery.data ?? []);
</script>

<div class="memory-root">
  <header class="page-header">
    <h1>Memory</h1>
    <p class="subtitle">Browse workspace memories</p>
  </header>

  {#if workspacesQuery.isLoading}
    <div class="loading">Loading workspaces…</div>
  {:else if workspacesQuery.error}
    <div class="error-banner">
      <span>Failed to load workspaces: {workspacesQuery.error.message}</span>
      <button class="dismiss" onclick={() => workspacesQuery.refetch()}>Retry</button>
    </div>
  {:else if workspaces.length === 0}
    <div class="empty">No workspaces with memories found.</div>
  {:else}
    <ul class="workspace-list">
      {#each workspaces as ws (ws)}
        <li>
          <a href="/memory/{encodeURIComponent(ws)}" class="workspace-card">
            <span class="ws-dot"></span>
            <span class="ws-name">{ws}</span>
          </a>
        </li>
      {/each}
    </ul>
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
    background: var(--blue-2, #60a5fa);
    block-size: 8px;
    border-radius: 50%;
    flex-shrink: 0;
    inline-size: 8px;
  }

  .ws-name {
    font-family: var(--font-mono);
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-5);
  }
</style>
