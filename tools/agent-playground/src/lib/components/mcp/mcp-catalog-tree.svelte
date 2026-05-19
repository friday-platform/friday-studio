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
  import type { MCPServerMetadata } from "@atlas/core/mcp-registry/schemas";
  import { IconSmall } from "@atlas/ui";
  import { createQuery } from "@tanstack/svelte-query";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { mcpQueries } from "$lib/queries/mcp-queries";
  import { shortenServerName, sourceLabel } from "./mcp-server-utils";

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
    [...filteredInstalled].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    ),
  );

  function securityColor(rating: string | undefined): string {
    switch (rating) {
      case "high":
        return "var(--green-primary)";
      case "medium":
        return "var(--yellow-primary)";
      case "low":
        return "var(--red-primary)";
      default:
        return "var(--text-faded)";
    }
  }

  /**
   * Status badge for an install still mid-flow, so the user can resume it.
   * `ready` entries that are clean / attention (or have no doctor report at
   * all) get no badge — they're finished products.
   */
  function statusBadge(
    server: MCPServerMetadata,
  ): { label: string; tone: "info" | "warn" } | null {
    if (server.status === "setting_up") {
      return { label: "Installing…", tone: "info" };
    }
    if (server.status === "awaiting_confirm") {
      return { label: "Awaiting setup", tone: "warn" };
    }
    if (server.doctor_report?.verdict === "unknown") {
      return { label: "Needs configuration", tone: "warn" };
    }
    return null;
  }
</script>

<div class="catalog-tree">
  <!-- Search -->
  <div class="search-field">
    <span class="search-icon"><IconSmall.Search /></span>
    <input
      type="text"
      placeholder="Search"
      bind:value={searchInput}
      oninput={handleSearchInput}
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
          {@const badge = statusBadge(server)}
          <button
            class="tree-item"
            class:active={selectedServerId === server.id}
            onclick={() => onSelectServer(server.id)}
          >
            <span
              class="security-dot"
              style:--dot-color={securityColor(server.securityRating)}
            ></span>
            <span class="item-name">{shortenServerName(server.name)}</span>
            {#if badge}
              <span class="status-badge" data-tone={badge.tone}
                >{badge.label}</span
              >
            {:else}
              <span class="tag-pill">{sourceLabel(server.source)}</span>
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
    /* ListDetail's aside is full-bleed at the block-end (no padding) so
       the chat consumer's overlay footer can sit flush; tree-style
       sidebars add their own bottom gutter so the last item isn't
       jammed against the edge when the list scrolls. */
    padding-block-end: var(--size-4);
  }

  /* ─── Search field ─────────────────────────────────────────────────────── */

  .search-field {
    align-items: center;
    background: var(--highlight);
    border-radius: var(--radius-3);
    block-size: var(--size-7-5);
    display: flex;
    gap: var(--size-1-5);
    padding-inline: var(--size-3);
    transition: background-color 120ms ease;

    .search-icon {
      color: var(--text-faded);
      display: flex;
      flex-shrink: 0;
    }

    input {
      background: transparent;
      block-size: 100%;
      color: var(--text-bright);
      font-family: inherit;
      font-size: var(--font-size-3);
      font-weight: var(--font-weight-4-5);
      inline-size: 100%;
      outline: none;

      &::placeholder {
        color: var(--text-faded);
      }
    }

    &:focus-within {
      background: var(--highlight-bright);
    }
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
    border-radius: var(--radius-2-5);
    border: none;
    color: var(--text);
    cursor: pointer;
    display: flex;
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-4-5);
    gap: var(--size-1-5);
    inline-size: 100%;
    padding-inline: var(--size-3);
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

  .status-badge {
    background: color-mix(in srgb, var(--badge-tone), transparent 88%);
    border-radius: var(--radius-2);
    color: var(--badge-tone);
    flex-shrink: 0;
    font-size: var(--font-size-0);
    font-weight: var(--font-weight-5);
    padding: 1px var(--size-1-5);
    white-space: nowrap;
  }

  .status-badge[data-tone="info"] {
    --badge-tone: var(--blue-primary);
  }

  .status-badge[data-tone="warn"] {
    --badge-tone: var(--yellow-primary);
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
    background: var(--surface-bright);
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
    color: var(--text-faded);
    font-size: var(--font-size-2);
    padding: var(--size-2) var(--size-1);
    text-align: center;
    word-break: break-all;
  }
</style>
