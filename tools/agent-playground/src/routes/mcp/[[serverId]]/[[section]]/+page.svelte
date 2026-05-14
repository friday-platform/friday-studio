<!--
  MCP Catalog — drill-down browser.

  The content area shows either the catalog list or a single server's detail
  view; navigating between them animates as a drill-down. The app's left
  sidebar nav stays fixed throughout.

  Route: /mcp          → catalog list
  Route: /mcp/{id}     → detail for server {id}

  @component
-->

<script lang="ts">
  import { Button, toast } from "@atlas/ui";
  import { createQuery } from "@tanstack/svelte-query";
  import { fly } from "svelte/transition";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import MCPCatalogTree from "$lib/components/mcp/mcp-catalog-tree.svelte";
  import MCPRegistryImport from "$lib/components/mcp/mcp-registry-import.svelte";
  import MCPServerDetail from "$lib/components/mcp/mcp-server-detail.svelte";
  import {
    mcpQueries,
    useCheckMCPUpdate,
    useDeleteMCPServer,
    useInstallMCPServer,
    usePullMCPUpdate,
  } from "$lib/queries/mcp-queries";

  // ---------------------------------------------------------------------------
  // Selection from URL param
  // ---------------------------------------------------------------------------

  const selectedServerId = $derived(page.params.serverId ?? null);
  const selectedSection = $derived(page.params.section ?? null);
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

<div class="mcp-page">
  {#if selectedServerId}
    <!-- Detail view — drills in from the right. -->
    <div class="view" in:fly={{ x: 24, duration: 200, opacity: 0 }}>
      <MCPServerDetail
        server={selectedServer}
        section={selectedSection}
        onBack={handleBack}
        onSelectSection={handleSelectSection}
        onCheckUpdate={handleCheckUpdate}
        onPullUpdate={handlePullUpdate}
        onDelete={handleDelete}
        checking={checkingId === selectedServerId}
        pulling={pullingId === selectedServerId}
        deleting={deletingId === selectedServerId}
        {hasUpdate}
      />
    </div>
  {:else}
    <!-- Catalog list — drills back in from the left. -->
    <div class="view list-view" in:fly={{ x: -24, duration: 200, opacity: 0 }}>
      <header class="list-header">
        <h1>MCP Catalog</h1>
        <Button
          variant="secondary"
          size="small"
          aria-label="Import from registry"
          onclick={() => (importDialogOpen = true)}
        >
          Add New
        </Button>
      </header>
      <MCPCatalogTree {selectedServerId} onSelectServer={handleSelectServer} />
    </div>
  {/if}
</div>

<MCPRegistryImport
  open={importDialogOpen}
  onclose={() => (importDialogOpen = false)}
  onInstall={handleInstall}
  installing={installMut.isPending}
/>

<style>
  .mcp-page {
    block-size: 100%;
    display: flex;
    flex-direction: column;
    min-block-size: 0;
  }

  .view {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-block-size: 0;
  }

  .list-view {
    gap: var(--size-4);
    padding: var(--size-6) var(--size-8);
  }

  .list-header {
    align-items: center;
    display: flex;
    gap: var(--size-3);
    justify-content: space-between;
  }

  .list-header h1 {
    color: var(--text-bright);
    font-size: var(--font-size-7);
    font-weight: var(--font-weight-6);
    margin: 0;
  }
</style>
