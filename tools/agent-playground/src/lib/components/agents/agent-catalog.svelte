<!--
  Searchable, keyboard-navigable catalog of all bundled agents.

  Search filters across displayName, description, and examples in real-time.
  Agents render as CatalogRow components with expandable spec sheets.

  Keyboard shortcuts:
  - Cmd+K: Focus search input
  - Arrow Up/Down: Move focus between agents
  - Enter: Toggle spec sheet on focused agent
  - Cmd+Enter: Navigate to workbench for focused agent
  - Escape: Clear search and reset focus

  @component
  @param {AgentMetadata[]} agents - All bundled agents to display
-->

<script lang="ts">
  import { goto } from "$app/navigation";
  import type { AgentMetadata } from "$lib/queries";
  import CatalogRow from "./catalog-row.svelte";

  type Props = { agents: AgentMetadata[] };

  let { agents }: Props = $props();

  let searchQuery = $state("");
  let expandedId = $state<string | null>(null);
  let focusedIndex = $state(-1);
  let searchInput = $state<HTMLInputElement | null>(null);
  let rowElements: HTMLElement[] = $state([]);

  /**
   * Score an agent against the search query.
   * Higher score = better match. Returns 0 for no match.
   *
   * Ranking: exact name match (4) > name includes (3) > description includes (2) > example includes (1)
   */
  function scoreAgent(agent: AgentMetadata, query: string): number {
    const q = query.toLowerCase();
    const name = agent.displayName.toLowerCase();

    if (name === q) return 4;
    if (name.includes(q)) return 3;
    if (agent.description?.toLowerCase().includes(q)) return 2;
    if (agent.examples.some((ex) => ex.toLowerCase().includes(q))) return 1;
    return 0;
  }

  /** Filtered and ranked agents list. */
  const filteredAgents = $derived.by(() => {
    if (!searchQuery.trim()) {
      return [...agents].sort((a, b) => a.displayName.localeCompare(b.displayName));
    }

    const query = searchQuery.trim();
    const scored = agents
      .map((agent) => ({ agent, score: scoreAgent(agent, query) }))
      .filter((entry) => entry.score > 0);

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.agent.displayName.localeCompare(b.agent.displayName);
    });

    return scored.map((entry) => entry.agent);
  });

  function navigate(agentId: string) {
    goto(`/agents/built-in/${encodeURIComponent(agentId)}`);
  }

  function toggleExpanded(agentId: string) {
    expandedId = expandedId === agentId ? null : agentId;
  }

  function focusRow(index: number) {
    const clamped = Math.max(0, Math.min(index, filteredAgents.length - 1));
    focusedIndex = clamped;
    const el = rowElements[clamped];
    if (el) {
      const button = el.querySelector<HTMLElement>(".row-header");
      button?.focus();
      el.scrollIntoView({ block: "nearest" });
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    // Cmd+K: focus search
    if ((e.metaKey || e.ctrlKey) && e.key === "k") {
      e.preventDefault();
      searchInput?.focus();
      searchInput?.select();
      return;
    }

    // Escape: clear search and reset focus
    if (e.key === "Escape") {
      e.preventDefault();
      searchQuery = "";
      focusedIndex = -1;
      searchInput?.blur();
      return;
    }

    // Arrow keys and Enter only apply when not typing in search
    // (unless search is focused, arrows should still navigate)
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (filteredAgents.length === 0) return;
      focusRow(focusedIndex + 1);
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (filteredAgents.length === 0) return;
      if (focusedIndex <= 0) {
        focusedIndex = -1;
        searchInput?.focus();
        return;
      }
      focusRow(focusedIndex - 1);
      return;
    }

    // Enter: toggle spec sheet on focused agent
    // Cmd+Enter: navigate to workbench
    if (e.key === "Enter" && focusedIndex >= 0 && focusedIndex < filteredAgents.length) {
      e.preventDefault();
      const agent = filteredAgents[focusedIndex];
      if (!agent) return;
      if (e.metaKey || e.ctrlKey) {
        navigate(agent.id);
      } else {
        toggleExpanded(agent.id);
      }
      return;
    }
  }

  function handleSearchKeydown(e: KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (filteredAgents.length > 0) {
        focusRow(0);
      }
    }
  }

  /** Reset focus when search changes. */
  $effect(() => {
    // Access searchQuery to create dependency
    void searchQuery;
    focusedIndex = -1;
  });

  /** Reset row elements array when filtered list changes length. */
  $effect(() => {
    rowElements = new Array(filteredAgents.length);
  });

  const resultCount = $derived(
    searchQuery.trim()
      ? `${filteredAgents.length} result${filteredAgents.length !== 1 ? "s" : ""}`
      : `${agents.length} bundled agents`,
  );
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="catalog">
  <header class="catalog-header">
    <h1>Agents</h1>
    <div class="search-row">
      <input
        bind:this={searchInput}
        bind:value={searchQuery}
        class="search-input"
        type="text"
        placeholder="Search agents..."
        onkeydown={handleSearchKeydown}
        aria-label="Search agents"
      />
      <kbd class="shortcut-hint">⌘K</kbd>
    </div>
    <p class="subtitle">{resultCount}</p>
  </header>

  <div class="agent-list" role="list">
    {#each filteredAgents as agent, i (agent.id)}
      <div bind:this={rowElements[i]} role="listitem">
        <CatalogRow
          {agent}
          expanded={expandedId === agent.id}
          onToggle={() => toggleExpanded(agent.id)}
          onNavigate={navigate}
          onExampleClick={() => navigate(agent.id)}
        />
      </div>
    {/each}

    {#if searchQuery.trim() && filteredAgents.length === 0}
      <div class="empty-state">
        <p>No agents match "{searchQuery}"</p>
      </div>
    {/if}
  </div>
</div>

<style>
  .catalog {
    block-size: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .catalog-header {
    border-block-end: 1px solid var(--color-border-1);
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    gap: var(--size-3);
    padding-block: var(--size-5);
    padding-inline: var(--size-6);

    h1 {
      font-size: var(--font-size-6);
      font-weight: var(--font-weight-6);
    }
  }

  .search-row {
    align-items: center;
    display: flex;
    gap: var(--size-2);
  }

  .search-input {
    background-color: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    color: var(--color-text);
    flex: 1;
    font-size: var(--font-size-2);
    padding-block: var(--size-2);
    padding-inline: var(--size-3);
  }

  .search-input::placeholder {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
  }

  .search-input:focus {
    border-color: var(--color-focus, var(--color-link));
    outline: none;
  }

  .shortcut-hint {
    background-color: color-mix(in srgb, var(--color-surface-2), transparent 30%);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-1);
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    flex-shrink: 0;
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-0);
    padding-block: var(--size-0-5);
    padding-inline: var(--size-1-5);
  }

  .subtitle {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-2);
  }

  .agent-list {
    flex: 1;
    overflow-y: auto;
  }

  .empty-state {
    align-items: center;
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    display: flex;
    font-size: var(--font-size-3);
    justify-content: center;
    padding-block: var(--size-10);
  }
</style>
