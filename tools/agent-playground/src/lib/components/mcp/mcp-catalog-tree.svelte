<!--
  MCP Catalog Tree — list of installed servers for the catalog sidebar.

  Shows installed servers grouped by source. Search filters installed servers.
  Search query is synced to the URL (?q=) for shareable/bookmarkable filtered views.
  Registry discovery lives in the import modal only.

  @component
  @prop selectedServerId - ID of currently selected installed server
  @prop onSelectServer - Called when an installed server is clicked
-->

<script lang="ts">
  import { IconSmall } from "@atlas/ui";
  import { createQuery } from "@tanstack/svelte-query";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { isOfficialCanonicalName } from "@atlas/core/mcp-registry/official-servers";
  import { mcpQueries } from "$lib/queries/mcp-queries";

  interface Props {
    selectedServerId?: string | null;
    onSelectServer: (serverId: string) => void;
  }

  let { selectedServerId = null, onSelectServer }: Props = $props();

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  const catalogQuery = createQuery(() => mcpQueries.catalog());
  const allServers = $derived(catalogQuery.data?.servers ?? []);

  // ---------------------------------------------------------------------------
  // URL-driven search
  // ---------------------------------------------------------------------------

  const urlQuery = $derived(page.url.searchParams.get("q") ?? "");

  // Local input mirrors URL; effect handles back-button / external nav sync
  let searchInput = $state(page.url.searchParams.get("q") ?? "");
  $effect(() => {
    searchInput = urlQuery;
  });

  let searchDebounce: ReturnType<typeof setTimeout> | undefined;
  let searchFocused = $state(false);
  let searchRef: HTMLInputElement | null = $state(null);

  function handleSearchInput(): void {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      const trimmed = searchInput.trim();
      const url = new URL(page.url);
      if (trimmed) {
        url.searchParams.set("q", trimmed);
      } else {
        url.searchParams.delete("q");
      }
      goto(url.toString(), { replaceState: true, keepFocus: true });
    }, 200);
  }

  $effect(() => {
    return () => clearTimeout(searchDebounce);
  });

  // ---------------------------------------------------------------------------
  // Filtering
  // ---------------------------------------------------------------------------

  const queryLower = $derived(urlQuery.toLowerCase());

  const filteredInstalled = $derived.by(() => {
    if (!urlQuery) return allServers;
    return allServers.filter(
      (s) =>
        s.name.toLowerCase().includes(queryLower) ||
        (s.description?.toLowerCase().includes(queryLower) ?? false),
    );
  });

  const builtInServers = $derived(filteredInstalled.filter((s) => s.source === "static"));
  const registryInstalled = $derived(filteredInstalled.filter((s) => s.source === "registry"));
  const otherInstalled = $derived(
    filteredInstalled.filter((s) => s.source !== "static" && s.source !== "registry"),
  );

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function transportBadge(server: (typeof allServers)[number]): string {
    return server.configTemplate.transport?.type ?? "unknown";
  }

  function securityColor(rating: string | undefined): string {
    switch (rating) {
      case "high":
        return "var(--color-success)";
      case "medium":
        return "var(--color-warning)";
      case "low":
        return "var(--color-error)";
      default:
        return "color-mix(in srgb, var(--color-text), transparent 45%)";
    }
  }

  function isOfficialServer(
    server: (typeof allServers)[number],
  ): boolean {
    if (server.source === "static") return true;
    if (server.upstream?.canonicalName) {
      return isOfficialCanonicalName(server.upstream.canonicalName);
    }
    return false;
  }
</script>

<div class="catalog-tree">
  <!-- Search -->
  <div class="search-field" class:focused={searchFocused}>
    <span class="search-icon"><IconSmall.Search /></span>
    <input
      type="text"
      placeholder="Search"
      bind:value={searchInput}
      bind:this={searchRef}
      oninput={handleSearchInput}
      onfocus={() => (searchFocused = true)}
      onblur={() => (searchFocused = false)}
      autocomplete="off"
    />
  </div>

  <!-- Installed servers -->
  <div class="tree-section">
    <div class="section-header">
      <span class="section-label">Installed</span>
      <span class="section-count">{filteredInstalled.length}</span>
    </div>

    {#if catalogQuery.isLoading}
      <div class="tree-skeleton">
        {#each Array.from({ length: 4 }) as _, i (i)}
          <div class="skeleton-row"></div>
        {/each}
      </div>
    {:else if filteredInstalled.length === 0 && urlQuery.length > 0}
      <p class="tree-empty">No installed servers match "{urlQuery}"</p>
    {:else}
      {#if builtInServers.length > 0}
        <div class="group">
          <span class="group-label">Built-in</span>
          {#each builtInServers as server (server.id)}
            <button
              class="tree-item"
              class:active={selectedServerId === server.id}
              onclick={() => onSelectServer(server.id)}
            >
              <span
                class="security-dot"
                style:--dot-color={securityColor(server.securityRating)}
              ></span>
              <span class="item-name">{server.name}</span>
              {#if isOfficialServer(server)}
                <span class="official-pill">Official</span>
              {/if}
              <span class="item-meta">{transportBadge(server)}</span>
            </button>
          {/each}
        </div>
      {/if}

      {#if registryInstalled.length > 0}
        <div class="group">
          <span class="group-label">From Registry</span>
          {#each registryInstalled as server (server.id)}
            <button
              class="tree-item"
              class:active={selectedServerId === server.id}
              onclick={() => onSelectServer(server.id)}
            >
              <span
                class="security-dot"
                style:--dot-color={securityColor(server.securityRating)}
              ></span>
              <span class="item-name">{server.name}</span>
              {#if isOfficialServer(server)}
                <span class="official-pill">Official</span>
              {/if}
              <span class="item-meta">{transportBadge(server)}</span>
            </button>
          {/each}
        </div>
      {/if}

      {#if otherInstalled.length > 0}
        <div class="group">
          <span class="group-label">Other</span>
          {#each otherInstalled as server (server.id)}
            <button
              class="tree-item"
              class:active={selectedServerId === server.id}
              onclick={() => onSelectServer(server.id)}
            >
              <span
                class="security-dot"
                style:--dot-color={securityColor(server.securityRating)}
              ></span>
              <span class="item-name">{server.name}</span>
              {#if isOfficialServer(server)}
                <span class="official-pill">Official</span>
              {/if}
              <span class="item-meta">{transportBadge(server)}</span>
            </button>
          {/each}
        </div>
      {/if}
    {/if}
  </div>
</div>

<style>
  .catalog-tree {
    display: flex;
    flex-direction: column;
    gap: var(--size-4);
  }

  /* ─── Search field ─────────────────────────────────────────────────────── */

  .search-field {
    align-items: center;
    background: var(--surface);
    border: none;
    border-radius: var(--radius-2);
    display: flex;
    gap: var(--size-2);
    padding: 0 var(--size-3);
    transition: background-color 120ms ease;
  }

  .search-field.focused {
    /* No visual change on focus — the caret is enough */
  }

  .search-icon {
    color: color-mix(in srgb, var(--color-text), transparent 45%);
    display: flex;
    flex-shrink: 0;
  }

  .search-field input {
    background: transparent;
    border: none;
    color: var(--color-text);
    font-family: inherit;
    font-size: var(--font-size-2);
    inline-size: 100%;
    outline: none;
    padding: var(--size-2) 0;
  }

  .search-field input::placeholder {
    color: color-mix(in srgb, var(--color-text), transparent 70%);
  }

  /* ─── Tree sections ────────────────────────────────────────────────────── */

  .tree-section {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  .section-header {
    align-items: center;
    display: flex;
    gap: var(--size-2);
    padding: 0 var(--size-1);
  }

  .section-label {
    color: color-mix(in srgb, var(--color-text), transparent 45%);
    font-size: var(--font-size-0);
    font-weight: var(--font-weight-6);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .section-count {
    color: color-mix(in srgb, var(--color-text), transparent 65%);
    font-size: var(--font-size-0);
    font-variant-numeric: tabular-nums;
  }

  /* ─── Groups ───────────────────────────────────────────────────────────── */

  .group {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .group-label {
    color: color-mix(in srgb, var(--color-text), transparent 55%);
    font-size: var(--font-size-0);
    font-weight: var(--font-weight-5);
    padding: var(--size-1) var(--size-2);
  }

  /* ─── Tree items ───────────────────────────────────────────────────────── */

  .tree-item {
    align-items: center;
    background: none;
    border: none;
    border-radius: var(--radius-2);
    color: var(--color-text);
    cursor: pointer;
    display: flex;
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-4);
    gap: var(--size-1-5);
    inline-size: 100%;
    opacity: 0.85;
    padding: var(--size-1) var(--size-2);
    text-align: start;
    transition: background-color 100ms ease, opacity 100ms ease;
  }

  .tree-item:hover {
    background-color: color-mix(in srgb, var(--color-surface-2), transparent 50%);
    opacity: 1;
  }

  .tree-item.active {
    background-color: var(--color-surface-2);
    font-weight: var(--font-weight-5);
    opacity: 1;
  }

  .security-dot {
    background-color: var(--dot-color);
    block-size: 6px;
    border-radius: 50%;
    flex-shrink: 0;
    inline-size: 6px;
  }

  .item-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .official-pill {
    background: var(--color-accent);
    border-radius: var(--radius-1);
    color: var(--color-surface-1);
    flex-shrink: 0;
    font-size: var(--font-size-0);
    font-weight: var(--font-weight-5);
    letter-spacing: 0.02em;
    line-height: 1;
    padding: 1px 5px;
  }

  .item-meta {
    color: color-mix(in srgb, var(--color-text), transparent 45%);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-0);
    flex-shrink: 0;
  }

  /* ─── Skeleton / Empty ─────────────────────────────────────────────────── */

  .tree-skeleton {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
    padding: 0 var(--size-1);
  }

  .skeleton-row {
    animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
    background: var(--color-surface-3);
    border-radius: 4px;
    block-size: 28px;
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.5;
    }
  }

  .tree-empty {
    color: color-mix(in srgb, var(--color-text), transparent 45%);
    font-size: var(--font-size-1);
    margin: 0;
    padding: var(--size-2) var(--size-1);
  }
</style>
