<!--
  MCP Catalog — a single ListDetail surface.

  The middle column (the ListDetail sidebar) is the navigator: it shows the
  installed-server catalog list, and when a server is selected it animates to
  that server's section nav. The app's left sidebar nav stays fixed. The
  content column shows either an empty prompt or the selected server's
  active section.

  Route: /mcp                      → catalog list, empty content
  Route: /mcp/{id}                 → section nav, server overview
  Route: /mcp/{id}/{section}       → section nav, that section

  @component
-->

<script lang="ts">
  import { Button, ListDetail, toast } from "@atlas/ui";
  import { createQuery } from "@tanstack/svelte-query";
  import { fly } from "svelte/transition";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import MCPCatalogTree from "$lib/components/mcp/mcp-catalog-tree.svelte";
  import McpSectionNav from "$lib/components/mcp/mcp-section-nav.svelte";
  import MCPRegistryImport from "$lib/components/mcp/mcp-registry-import.svelte";
  import MCPServerDetail from "$lib/components/mcp/mcp-server-detail.svelte";
  import {
    mcpQueries,
    useCheckMCPUpdate,
    useDeleteMCPServer,
    useInstallMCPServer,
    usePullMCPUpdate,
  } from "$lib/queries/mcp-queries";

  // ── Selection from URL params ──────────────────────────────────────────
  const selectedServerId = $derived(page.params.serverId ?? null);
  const selectedSection = $derived(page.params.section ?? null);
  let importDialogOpen = $state(false);

  // ── Queries ────────────────────────────────────────────────────────────
  const catalogQuery = createQuery(() => mcpQueries.catalog());
  const allServers = $derived(catalogQuery.data?.servers ?? []);
  const selectedServer = $derived(
    selectedServerId ? (allServers.find((s) => s.id === selectedServerId) ?? null) : null,
  );

  // ── Mutations ──────────────────────────────────────────────────────────
  const installMut = useInstallMCPServer();
  const checkMut = useCheckMCPUpdate();
  const pullMut = usePullMCPUpdate();
  const deleteMut = useDeleteMCPServer();

  const checkingId = $derived.by(() =>
    checkMut.isPending && checkMut.variables ? checkMut.variables : null,
  );
  const pullingId = $derived.by(() =>
    pullMut.isPending && pullMut.variables ? pullMut.variables : null,
  );
  const deletingId = $derived.by(() =>
    deleteMut.isPending && deleteMut.variables ? deleteMut.variables : null,
  );

  let updateState = $state<Record<string, boolean>>({});

  // ── Handlers ───────────────────────────────────────────────────────────
  function handleSelectServer(serverId: string): void {
    goto(`/mcp/${serverId}`);
  }

  function handleBack(): void {
    goto("/mcp");
  }

  function handleSelectSection(section: string): void {
    if (selectedServerId) goto(`/mcp/${selectedServerId}/${section}`);
  }

  async function handleInstall(registryName: string): Promise<void> {
    try {
      const result = await installMut.mutateAsync({ registryName });
      importDialogOpen = false;
      toast({
        title: result.status === "setting_up" ? "Setting up MCP server" : "MCP server installed",
        description:
          result.status === "setting_up"
            ? `${registryName} is being analyzed by the setup doctor.`
            : `${registryName} has been added to your catalog.`,
      });
      // The detail page is a stable URL — go there straight away, even while
      // the setup doctor is still running.
      goto(`/mcp/${result.server_id}`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toast({ title: "Install failed", description: message, error: true });
      throw e; // re-throw so the dialog can show the error
    }
  }

  async function handleCheckUpdate(): Promise<void> {
    if (!selectedServerId) return;
    try {
      const result = await checkMut.mutateAsync(selectedServerId);
      updateState = { ...updateState, [selectedServerId]: result.hasUpdate };
      toast({
        title: result.hasUpdate ? "Update available" : "Up to date",
        description: result.hasUpdate
          ? `${selectedServer?.name ?? "Server"} has an update available.`
          : `${selectedServer?.name ?? "Server"} is at the latest version.`,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toast({ title: "Check failed", description: message, error: true });
    }
  }

  async function handlePullUpdate(): Promise<void> {
    if (!selectedServerId) return;
    try {
      await pullMut.mutateAsync(selectedServerId);
      updateState = { ...updateState, [selectedServerId]: false };
      toast({
        title: "Update pulled",
        description: `${selectedServer?.name ?? "Server"} has been updated.`,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toast({ title: "Update failed", description: message, error: true });
    }
  }

  async function handleDelete(): Promise<void> {
    if (!selectedServerId) return;
    try {
      await deleteMut.mutateAsync(selectedServerId);
      toast({
        title: "Server removed",
        description: `${selectedServer?.name ?? "Server"} has been removed from your catalog.`,
      });
      goto("/mcp", { replaceState: true });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toast({ title: "Delete failed", description: message, error: true });
    }
  }

  const hasUpdate = $derived(selectedServerId ? (updateState[selectedServerId] ?? false) : false);
</script>

<ListDetail>
  {#snippet header()}
    {#if selectedServerId}
      <button type="button" class="back-link" onclick={handleBack}>
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
          <path
            d="M9.5 11.5 6 8l3.5-3.5"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        MCP Catalog
      </button>
    {:else}
      <h1>MCP Catalog</h1>
      <Button
        variant="secondary"
        size="small"
        aria-label="Import from registry"
        onclick={() => (importDialogOpen = true)}
      >
        Add New
      </Button>
    {/if}
  {/snippet}

  {#snippet sidebar()}
    {#key !!selectedServerId}
      <div class="nav-swap" in:fly={{ x: selectedServerId ? 16 : -16, duration: 180 }}>
        {#if selectedServerId}
          <McpSectionNav
            server={selectedServer}
            activeSection={selectedSection ?? "overview"}
            onSelectSection={handleSelectSection}
          />
        {:else}
          <MCPCatalogTree {selectedServerId} onSelectServer={handleSelectServer} />
        {/if}
      </div>
    {/key}
  {/snippet}

  {#if selectedServerId}
    <MCPServerDetail
      server={selectedServer}
      section={selectedSection}
      onCheckUpdate={handleCheckUpdate}
      onPullUpdate={handlePullUpdate}
      onDelete={handleDelete}
      checking={checkingId === selectedServerId}
      pulling={pullingId === selectedServerId}
      deleting={deletingId === selectedServerId}
      {hasUpdate}
    />
  {:else}
    <div class="empty-content">
      <p class="empty-title">MCP Catalog</p>
      <p class="empty-desc">
        Select a server from the list to view its configuration, tools, and connections — or
        add a new one from the registry.
      </p>
    </div>
  {/if}
</ListDetail>

<MCPRegistryImport
  open={importDialogOpen}
  onclose={() => (importDialogOpen = false)}
  onInstall={handleInstall}
  installing={installMut.isPending}
/>

<style>
  .back-link {
    align-items: center;
    background: none;
    border: none;
    color: var(--text);
    cursor: pointer;
    display: inline-flex;
    font: inherit;
    font-size: var(--font-size-3);
    gap: var(--size-1);
    padding: var(--size-1) 0;
  }

  .back-link:hover {
    color: var(--text-bright);
  }

  .nav-swap {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .empty-content {
    align-items: center;
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--size-2);
    justify-content: center;
    padding: var(--size-16);
    text-align: center;
  }

  .empty-title {
    color: var(--text-bright);
    font-size: var(--font-size-5);
    font-weight: var(--font-weight-6);
    margin: 0;
  }

  .empty-desc {
    color: var(--text);
    font-size: var(--font-size-3);
    line-height: 1.5;
    margin: 0;
    max-inline-size: 48ch;
  }
</style>
