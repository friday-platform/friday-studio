<!--
  MCP Catalog — two-pane browser layout.

  Left pane: searchable catalog tree of installed + registry servers.
  Right pane: detail view with README, metadata, and actions.

  Route: /mcp          → no selection
  Route: /mcp/{id}     → detail for server {id}

  @component
-->

<script lang="ts">
  import { toast } from "@atlas/ui";
  import { createQuery } from "@tanstack/svelte-query";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import MCPCatalogTree from "$lib/components/mcp/mcp-catalog-tree.svelte";
  import MCPRegistryImport from "$lib/components/mcp/mcp-registry-import.svelte";
  import MCPServerDetail from "$lib/components/mcp/mcp-server-detail.svelte";
  import {
    useCheckMCPUpdate,
    useDeleteMCPServer,
    useInstallMCPServer,
    usePullMCPUpdate,
  } from "$lib/queries/mcp";
  import { mcpQueries } from "$lib/queries/mcp-queries";

  // ---------------------------------------------------------------------------
  // Selection from URL param
  // ---------------------------------------------------------------------------

  const selectedServerId = $derived(page.params.serverId ?? null);
  let importDialogOpen = $state(false);

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  const catalogQuery = createQuery(() => mcpQueries.catalog());
  const allServers = $derived(catalogQuery.data?.servers ?? []);

  const selectedServer = $derived(
    selectedServerId ? (allServers.find((s) => s.id === selectedServerId) ?? null) : null,
  );

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

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

  // Track hasUpdate per server ID
  let updateState = $state<Record<string, boolean>>({});

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  function handleSelectServer(serverId: string): void {
    goto(`/mcp/${serverId}`, { replaceState: true });
  }

  async function handleInstall(registryName: string): Promise<void> {
    try {
      await installMut.mutateAsync({ registryName });
      importDialogOpen = false;
      toast({
        title: "MCP server installed",
        description: `${registryName} has been added to your catalog.`,
      });
      // After install, navigate to the newly installed server
      const freshCatalog = await catalogQuery.refetch();
      const installed = freshCatalog.data?.servers.find(
        (s) => s.upstream?.canonicalName === registryName,
      );
      if (installed) {
        goto(`/mcp/${installed.id}`);
      }
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
      if (result.hasUpdate) {
        toast({
          title: "Update available",
          description: `${selectedServer?.name ?? "Server"} has an update available.`,
        });
      } else {
        toast({
          title: "Up to date",
          description: `${selectedServer?.name ?? "Server"} is at the latest version.`,
        });
      }
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

<div class="mcp-layout">
  <aside class="mcp-sidebar">
    <MCPCatalogTree
      {selectedServerId}
      onSelectServer={handleSelectServer}
      onOpenImport={() => (importDialogOpen = true)}
    />
  </aside>

  <div class="mcp-content">
    <MCPServerDetail
      server={selectedServer}
      onInstall={handleInstall}
      onCheckUpdate={handleCheckUpdate}
      onPullUpdate={handlePullUpdate}
      onDelete={handleDelete}
      installing={installMut.isPending}
      checking={checkingId === selectedServerId}
      pulling={pullingId === selectedServerId}
      deleting={deletingId === selectedServerId}
      {hasUpdate}
    />
  </div>
</div>

<MCPRegistryImport
  open={importDialogOpen}
  onclose={() => (importDialogOpen = false)}
  onInstall={handleInstall}
  installing={installMut.isPending}
/>

<style>
  .mcp-layout {
    background: var(--surface-dark);
    display: flex;
    block-size: 100%;
  }

  .mcp-sidebar {
    border-inline-start: var(--size-px) solid var(--border);
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    inline-size: 300px;
    overflow-y: auto;
    scrollbar-width: thin;
  }

  .mcp-content {
    background: var(--surface);
    border-start-start-radius: var(--radius-7);
    border-end-start-radius: var(--radius-7);
    display: flex;
    flex: 1;
    flex-direction: column;
    min-inline-size: 0;
    overflow-y: auto;
    scrollbar-width: thin;
  }
</style>
