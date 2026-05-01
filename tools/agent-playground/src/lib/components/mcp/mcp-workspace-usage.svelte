<!--
  MCP Workspace Usage — shows which workspaces have this server enabled,
  along with agent and job references.

  @component
  @prop serverId - The MCP server ID to check workspace usage for
-->

<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import { workspaceQueries } from "../../queries/workspace-queries";
  import { workspaceMcpQueries } from "../../queries/workspace-mcp-queries";

  interface Props {
    serverId: string;
  }

  let { serverId }: Props = $props();

  const workspaceListQuery = createQuery(() => workspaceQueries.list());

  const workspaces = $derived(workspaceListQuery.data ?? []);
</script>

<section class="workspace-usage-section">
  <h3 class="section-title">Workspace Usage</h3>

  {#if workspaceListQuery.isLoading}
    <div class="loading-state">Loading workspaces…</div>
  {:else if workspaces.length === 0}
    <div class="empty-state">No workspaces found.</div>
  {:else}
    <div class="workspace-list">
      {#each workspaces as ws (ws.id)}
        {@const statusQuery = createQuery(() => workspaceMcpQueries.status(ws.id))}
        {@const enabledServer = statusQuery.data?.enabled.find((s) => s.id === serverId)}
        {@const isEnabled = Boolean(enabledServer)}
        {@const isLoading = statusQuery.isLoading || statusQuery.isPending}

        <div class="workspace-row" class:enabled={isEnabled} class:loading={isLoading}>
          <div class="workspace-name">{ws.name || ws.id}</div>

          {#if isLoading}
            <span class="status-pill loading-pill">Checking…</span>
          {:else if isEnabled}
            <span class="status-pill enabled-pill">Enabled</span>
            {#if enabledServer?.agentIds && enabledServer.agentIds.length > 0}
              <div class="references">
                <span class="ref-label">Agents:</span>
                <span class="ref-values">{enabledServer.agentIds.join(", ")}</span>
              </div>
            {/if}
            {#if enabledServer?.jobIds && enabledServer.jobIds.length > 0}
              <div class="references">
                <span class="ref-label">Jobs:</span>
                <span class="ref-values">{enabledServer.jobIds.join(", ")}</span>
              </div>
            {/if}
          {:else}
            <span class="status-pill disabled-pill">Not enabled</span>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</section>

<style>
  .workspace-usage-section {
    border-block-start: 1px solid var(--color-border-1);
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
    padding-block-start: var(--size-4);
  }

  .section-title {
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-5);
    margin: 0;
  }

  .loading-state {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-size: var(--font-size-2);
  }

  .empty-state {
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    font-size: var(--font-size-2);
  }

  .workspace-list {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .workspace-row {
    align-items: baseline;
    background: var(--color-surface-1);
    border-radius: var(--radius-1);
    display: grid;
    gap: var(--size-2) var(--size-3);
    grid-template-columns: 1fr auto;
    padding: var(--size-2) var(--size-3);
  }

  .workspace-row.loading {
    opacity: 0.6;
  }

  .workspace-name {
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
  }

  .status-pill {
    border-radius: var(--radius-round);
    font-size: var(--font-size-0);
    font-weight: var(--font-weight-5);
    padding: 2px 8px;
    text-transform: uppercase;
  }

  .enabled-pill {
    background: color-mix(in srgb, var(--color-success), transparent 88%);
    color: var(--color-success);
  }

  .disabled-pill {
    background: color-mix(in srgb, var(--color-text), transparent 88%);
    color: color-mix(in srgb, var(--color-text), transparent 40%);
  }

  .loading-pill {
    background: color-mix(in srgb, var(--color-warning), transparent 88%);
    color: var(--color-warning);
  }

  .references {
    color: color-mix(in srgb, var(--color-text), transparent 20%);
    font-size: var(--font-size-1);
    grid-column: 1 / -1;
  }

  .ref-label {
    font-weight: var(--font-weight-5);
    text-transform: uppercase;
  }

  .ref-values {
    font-family: var(--font-family-monospace);
  }
</style>
