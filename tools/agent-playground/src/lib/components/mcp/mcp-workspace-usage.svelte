<!--
  MCP Workspace Usage — lists workspaces with this server enabled,
  or shows an empty-state message when none are.

  @component
  @prop serverId - The MCP server ID to check workspace usage for
-->

<script lang="ts">
  import { createQueries, createQuery } from "@tanstack/svelte-query";
  import type { EnrichedMCPServer } from "../../queries/workspace-mcp-queries";
  import { workspaceMcpQueries } from "../../queries/workspace-mcp-queries";
  import { workspaceQueries } from "../../queries/workspace-queries";

  interface Props {
    serverId: string;
  }

  let { serverId }: Props = $props();

  const workspaceListQuery = createQuery(() => workspaceQueries.enriched());
  const workspaces = $derived(workspaceListQuery.data ?? []);

  const statusQueries = createQueries(() => ({
    queries: workspaces.map((ws) => workspaceMcpQueries.status(ws.id)),
  }));

  type Row = {
    workspaceId: string;
    workspaceName: string;
    enabledServer: EnrichedMCPServer;
  };

  const enabledRows = $derived.by<Row[]>(() => {
    return workspaces.flatMap((ws, i): Row[] => {
      const enabledServer = statusQueries[i]?.data?.enabled.find((s) => s.id === serverId);
      if (!enabledServer) return [];
      return [{ workspaceId: ws.id, workspaceName: ws.displayName, enabledServer }];
    });
  });
</script>

{#if enabledRows.length > 0}
  <div class="workspace-list">
    {#each enabledRows as row (row.workspaceId)}
      <div class="workspace-row">
        <a class="workspace-name" href="/platform/{row.workspaceId}/settings/mcp">
          {row.workspaceName}
        </a>
        {#if row.enabledServer.agentIds && row.enabledServer.agentIds.length > 0}
          <div class="references">
            <span class="ref-label">Agents:</span>
            <span class="ref-values">{row.enabledServer.agentIds.join(", ")}</span>
          </div>
        {/if}
        {#if row.enabledServer.jobIds && row.enabledServer.jobIds.length > 0}
          <div class="references">
            <span class="ref-label">Jobs:</span>
            <span class="ref-values">{row.enabledServer.jobIds.join(", ")}</span>
          </div>
        {/if}
      </div>
    {/each}
  </div>
{:else}
  <div class="empty-state">Not used in any workspaces</div>
{/if}

<style>
  .workspace-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-px);
  }

  .workspace-row {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
    padding: var(--size-2) 0;
  }

  .workspace-name {
    align-self: flex-start;
    color: var(--blue-primary);
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-6);
    text-decoration: none;
  }

  .workspace-name:hover {
    text-decoration: underline;
  }

  .references {
    color: var(--text);
    font-size: var(--font-size-2);
  }

  .ref-label {
    color: var(--text);
    font-weight: var(--font-weight-6);
    margin-inline-end: var(--size-1);
  }

  .ref-values {
    font-family: var(--font-family-monospace);
  }

  .empty-state {
    color: var(--text);
    font-size: var(--font-size-3);
  }
</style>
