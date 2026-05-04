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
  import { isOfficialCanonicalName } from "@atlas/core/mcp-registry/official-servers";
  import { IconSmall } from "@atlas/ui";
  import { createQuery } from "@tanstack/svelte-query";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
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

  const sortedInstalled = $derived(
    [...filteredInstalled].sort((a, b) => {
      const aBundled = a.source === "static" ? 0 : 1;
      const bBundled = b.source === "static" ? 0 : 1;
      return aBundled - bBundled;
    }),
  );

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

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

  type ServerTag = "bundled" | "registry" | "official" | null;

  function serverTag(server: (typeof allServers)[number]): ServerTag {
    if (server.source === "static") return "bundled";
    if (server.source === "registry") return "registry";
    if (server.upstream?.canonicalName && isOfficialCanonicalName(server.upstream.canonicalName)) {
      return "official";
    }
    return null;
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
    {#if catalogQuery.isLoading}
      <div class="tree-skeleton">
        {#each Array.from({ length: 4 }) as _, i (i)}
          <div class="skeleton-row"></div>
        {/each}
      </div>
    {:else if filteredInstalled.length === 0 && urlQuery.length > 0}
      <p class="tree-empty">No installed servers match "{urlQuery}"</p>
    {:else}
      <div class="group">
        {#each sortedInstalled as server (server.id)}
          {@const tag = serverTag(server)}
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
            {#if tag === "bundled"}
              <span class="tag-pill">Bundled</span>
            {:else if tag === "registry"}
              <span class="tag-pill">Registry</span>
            {:else if tag === "official"}
              <span class="tag-pill">Official</span>
            {/if}
          </button>
        {/each}
      </div>
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
  }

  /* ─── Groups ───────────────────────────────────────────────────────────── */

  .group {
    display: flex;
    flex-direction: column;
  }

  /* ─── Tree items ───────────────────────────────────────────────────────── */

  .tree-item {
    align-items: center;
    background: none;
    block-size: var(--size-7-5);
    border-radius: var(--radius-2);
    border: none;
    color: var(--text);
    cursor: pointer;
    display: flex;
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-4-5);
    gap: var(--size-1-5);
    inline-size: 100%;
    padding: var(--size-1) var(--size-2);
    text-align: start;
    transition: color 150ms ease;
  }

  .tree-item:hover {
    color: var(--text-bright);
  }

  .tree-item.active {
    background-color: var(--highlight);
    color: var(--text-bright);
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

  .tag-pill {
    color: var(--text-faded);
    flex-shrink: 0;
    font-size: var(--font-size-1);
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
