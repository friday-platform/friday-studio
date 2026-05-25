<!--
  Searchable, keyboard-navigable catalog of all bundled agents.

  Search filters across displayName, description, and examples in real-time.
  Agents render as CatalogRow components with expandable spec sheets.

  Keyboard shortcuts:
  - Cmd+I: Focus search input
  - Arrow Up/Down: Move focus between agents
  - Enter: Toggle spec sheet on focused agent
  - Cmd+Enter: Navigate to workbench for focused agent
  - Escape: Clear search and reset focus

  @component
  @param {AgentMetadata[]} agents - All bundled agents to display
-->

<script lang="ts">
  import { getHotkeyRegistry } from "@atlas/ui";
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

  // Catalog keyboard shortcuts. Arrow + Enter bindings deliberately
  // run at window scope so the user can navigate the list from
  // anywhere on the page; the search input's own onkeydown handles
  // ArrowDown specifically (jumps from search into the list) and runs
  // before this since element-scoped listeners precede window ones.
  const hotkeys = getHotkeyRegistry();

  $effect(() => hotkeys.register({
    key: "i", cmdOrCtrl: true,
    handler: () => {
      searchInput?.focus();
      searchInput?.select();
    },
  }));

  $effect(() => hotkeys.register({
    key: "Escape",
    handler: () => {
      searchQuery = "";
      focusedIndex = -1;
      searchInput?.blur();
    },
  }));

  $effect(() => hotkeys.register({
    key: "ArrowDown",
    when: () => filteredAgents.length > 0,
    handler: () => focusRow(focusedIndex + 1),
  }));

  $effect(() => hotkeys.register({
    key: "ArrowUp",
    when: () => filteredAgents.length > 0,
    handler: () => {
      if (focusedIndex <= 0) {
        focusedIndex = -1;
        searchInput?.focus();
        return;
      }
      focusRow(focusedIndex - 1);
    },
  }));

  // Plain Enter toggles the focused agent's spec sheet.
  $effect(() => hotkeys.register({
    key: "Enter",
    when: () => focusedIndex >= 0 && focusedIndex < filteredAgents.length,
    handler: () => {
      const agent = filteredAgents[focusedIndex];
      if (agent) toggleExpanded(agent.id);
    },
  }));

  // Cmd/Ctrl+Enter opens the focused agent in the workbench.
  $effect(() => hotkeys.register({
    key: "Enter", cmdOrCtrl: true,
    when: () => focusedIndex >= 0 && focusedIndex < filteredAgents.length,
    handler: () => {
      const agent = filteredAgents[focusedIndex];
      if (agent) navigate(agent.id);
    },
  }));

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

  const resultCount = $derived.by(() => {
    if (searchQuery.trim()) {
      return `${filteredAgents.length} result${filteredAgents.length !== 1 ? "s" : ""}`;
    }
    const bundledCount = agents.filter((a) => a.source === "bundled").length;
    const userCount = agents.filter((a) => a.source === "user").length;
    if (userCount === 0) return `${bundledCount} bundled agents`;
    return `${bundledCount} bundled + ${userCount} user agents`;
  });
</script>

<div class="catalog">
  <header class="catalog-header">
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
      <kbd class="shortcut-hint">⌘I</kbd>
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
    color: color-mix(in srgb, var(--color-text), transparent 25%);
  }

  .search-input:focus {
    border-color: var(--color-focus, var(--color-link));
    outline: none;
  }

  .shortcut-hint {
    background-color: color-mix(in srgb, var(--color-surface-2), transparent 30%);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-1);
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    flex-shrink: 0;
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-1);
    padding-block: var(--size-0-5);
    padding-inline: var(--size-1-5);
  }

  .subtitle {
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    font-size: var(--font-size-2);
  }

  .agent-list {
    flex: 1;
    overflow-y: auto;
  }

  .empty-state {
    align-items: center;
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    display: flex;
    font-size: var(--font-size-3);
    justify-content: center;
    padding-block: var(--size-10);
  }
</style>
