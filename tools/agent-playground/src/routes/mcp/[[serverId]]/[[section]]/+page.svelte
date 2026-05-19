<!--
  MCP Catalog — a single ListDetail surface.

  The middle column (the ListDetail sidebar) is the navigator: it lists
  every installed server. Selecting a server expands it in place to
  reveal a sub-nav of detail sections (overview/connections/…) — there's
  no full-screen transition. The content column shows either an empty
  prompt or the selected server's active section.

  Route: /mcp                      → catalog list, empty content
  Route: /mcp/{id}                 → catalog list with {id} expanded, server overview
  Route: /mcp/{id}/{section}       → that section

  @component
-->

<script lang="ts">
  import { Button, ListDetail, toast } from "@atlas/ui";
  import { createQuery } from "@tanstack/svelte-query";
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
    // Re-selecting the open server collapses back to the catalog root.
    if (selectedServerId === serverId) {
      goto("/mcp");
      return;
    }
    goto(`/mcp/${serverId}`);
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
    <h1>MCP Catalog</h1>
    <Button
      variant="secondary"
      size="small"
      aria-label="Import from registry"
      onclick={() => (importDialogOpen = true)}
    >
      Add New
    </Button>
  {/snippet}

  {#snippet sidebar()}
    <MCPCatalogTree
      {selectedServerId}
      {selectedSection}
      onSelectServer={handleSelectServer}
      onSelectSection={handleSelectSection}
    />
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
      <p class="empty-title text-md">MCP Catalog</p>
      <p class="empty-desc text-sm">
        Select a server from the list to view its configuration, tools, and connections — or add a
        new one from the registry.
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
    font-weight: var(--font-weight-6);
    margin: 0;
  }

  .empty-desc {
    color: var(--text);
    line-height: 1.5;
    margin: 0;
    max-inline-size: 48ch;
  }
</style>
