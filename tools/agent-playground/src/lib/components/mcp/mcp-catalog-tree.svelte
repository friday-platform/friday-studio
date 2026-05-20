<!--
  MCP Catalog Tree — sidebar nav for the catalog.

  Lists installed servers; the selected server expands in place to reveal
  its section sub-nav (Overview, Connections, etc.). Search filters the
  installed list and syncs to `?q=` so the filtered view is shareable.
  Registry discovery happens in the import modal — this tree only shows
  what's already installed.

  @component
-->

<script lang="ts">
  import type { MCPServerMetadata } from "@atlas/core/mcp-registry/schemas";
  import { SidebarNav } from "@atlas/ui";
  import { createQuery } from "@tanstack/svelte-query";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { mcpQueries } from "$lib/queries/mcp-queries";
  import { shortenServerName, sourceLabel } from "./mcp-server-utils";

  interface Props {
    selectedServerId?: string | null;
    selectedSection?: string | null;
    onSelectServer: (serverId: string) => void;
    onSelectSection: (section: string) => void;
  }

  const {
    selectedServerId = null,
    selectedSection = null,
    onSelectServer,
    onSelectSection,
  }: Props = $props();

  const SECTIONS = [
    { id: "overview", label: "Overview" },
    { id: "connections", label: "Connections" },
    { id: "configuration", label: "Config Reference" },
    { id: "tools", label: "Testing" },
    { id: "readme", label: "Readme" },
  ] as const;

  // ── Queries ────────────────────────────────────────────────────────────

  const catalogQuery = createQuery(() => mcpQueries.catalog());
  const allServers = $derived(catalogQuery.data?.servers ?? []);

  // ── URL-driven search ──────────────────────────────────────────────────

  const urlQuery = $derived(page.url.searchParams.get("q") ?? "");
  let searchInput = $state(page.url.searchParams.get("q") ?? "");

  // Sync local input ← URL on back / external nav.
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

  // ── Filtering ──────────────────────────────────────────────────────────

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

  function statusBadge(server: MCPServerMetadata): { label: string; tone: "info" | "warn" } | null {
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

<SidebarNav.Root gap="loose">
  <SidebarNav.Search bind:value={searchInput} oninput={handleSearchInput} />

  {#if catalogQuery.isLoading}
    <div class="tree-skeleton">
      {#each Array.from({ length: 4 }) as _, i (i)}
        <div class="skeleton-row"></div>
      {/each}
    </div>
  {:else if filteredInstalled.length === 0 && urlQuery.length > 0}
    <p class="tree-empty text-xs">No installed servers match "{urlQuery}"</p>
  {:else}
    <div class="server-list">
      {#each sortedInstalled as server (server.id)}
        {@const badge = statusBadge(server)}
        {@const isSelected = selectedServerId === server.id}
        <!-- Legacy / static entries have no status — treat as ready,
             matching the original section-nav fallback. -->
        {@const canExpand = (server.status ?? "ready") === "ready"}

        <SidebarNav.Item
          active={isSelected}
          expanded={isSelected && canExpand}
          onclick={() => onSelectServer(server.id)}
        >
          <span
            class="security-dot"
            style:--dot-color={securityColor(server.securityRating)}
          ></span>
          <span class="item-name">{shortenServerName(server.name)}</span>
          {#if badge}
            <span class="status-badge text-2xs" data-tone={badge.tone}>{badge.label}</span>
          {:else}
            <span class="tag-pill text-2xs">{sourceLabel(server.source)}</span>
          {/if}

          {#snippet subItems()}
            {#each SECTIONS as s (s.id)}
              <SidebarNav.Item
                variant="sub"
                active={(selectedSection ?? "overview") === s.id}
                onclick={() => onSelectSection(s.id)}
              >
                <span class="section-label">{s.label}</span>
              </SidebarNav.Item>
            {/each}
          {/snippet}
        </SidebarNav.Item>
      {/each}
    </div>
  {/if}
</SidebarNav.Root>

<style>
  .server-list {
    display: flex;
    flex-direction: column;
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

  .section-label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tag-pill {
    color: var(--text-faded);
    flex-shrink: 0;
  }

  .status-badge {
    background-color: var(--badge-bg);
    border-radius: var(--radius-2);
    color: var(--badge-tone);
    flex-shrink: 0;
    font-weight: var(--font-weight-5);
    padding: 1px var(--size-1-5);
    white-space: nowrap;
  }

  .status-badge[data-tone="info"] {
    --badge-tone: var(--blue-primary);
    --badge-bg: var(--highlight);
  }

  .status-badge[data-tone="warn"] {
    --badge-tone: var(--yellow-primary);
    --badge-bg: var(--highlight);
  }

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
    padding: var(--size-2) var(--size-1);
    text-align: center;
    word-break: break-all;
  }
</style>
