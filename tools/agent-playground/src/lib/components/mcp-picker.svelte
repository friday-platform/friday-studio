<script lang="ts">
  /**
   * Multi-select MCP server picker with tool preview.
   * Fetches available servers from the registry, lets the user toggle
   * which servers to enable, and resolves their tool definitions.
   */

  import { Button, Collapsible, IconSmall } from "@atlas/ui";
  import { getClient, type Client } from "$lib/client.ts";
  import type { InferResponseType } from "hono/client";
  import { SvelteSet } from "svelte/reactivity";

  type ServersEndpoint = Client["api"]["mcp"]["servers"]["$get"];
  type ServersResponse = InferResponseType<ServersEndpoint>;
  type ServerInfo = ServersResponse[number];

  type ToolsEndpoint = Client["api"]["mcp"]["tools"]["$post"];
  type ToolsResponse = InferResponseType<ToolsEndpoint>;
  type ToolDefinition = ToolsResponse extends { tools: infer T }
    ? T extends Array<infer U>
      ? U
      : never
    : never;

  type Props = {
    env: Record<string, string>;
    onServersChange: (serverIds: string[]) => void;
    onToolsResolved: (tools: ToolDefinition[]) => void;
  };

  let { env, onServersChange, onToolsResolved }: Props = $props();

  let servers = $state<ServerInfo[]>([]);
  let selectedIds = new SvelteSet<string>();
  let tools = $state<ToolDefinition[]>([]);
  let toolErrors = $state<Array<{ serverId: string; error: string }>>([]);
  let loading = $state(true);
  let loadingTools = $state(false);
  let fetchError = $state<string | null>(null);

  async function fetchServers() {
    loading = true;
    fetchError = null;
    try {
      const res = await getClient().api.mcp.servers.$get();
      if (!res.ok) throw new Error(`Failed to fetch servers: ${res.status}`);
      const data = await res.json();
      servers = data;
    } catch (e) {
      fetchError = e instanceof Error ? e.message : "Failed to fetch servers";
    } finally {
      loading = false;
    }
  }

  function toggleServer(id: string) {
    if (selectedIds.has(id)) {
      selectedIds.delete(id);
    } else {
      selectedIds.add(id);
    }
  }

  /** Resolve tools whenever selection or env changes. */
  async function resolveTools(ids: string[], currentEnv: Record<string, string>) {
    if (ids.length === 0) {
      tools = [];
      toolErrors = [];
      onToolsResolved([]);
      return;
    }

    loadingTools = true;
    toolErrors = [];
    try {
      const res = await getClient().api.mcp.tools.$post({
        json: { serverIds: ids, env: currentEnv },
      });
      if (!res.ok) {
        const body = await res.json();
        const msg = "error" in body ? body.error : `Failed to fetch tools: ${res.status}`;
        toolErrors = [{ serverId: "request", error: msg }];
        tools = [];
        onToolsResolved([]);
        return;
      }
      const data = await res.json();
      tools = "tools" in data ? data.tools : [];
      if ("errors" in data && data.errors) {
        toolErrors = data.errors;
      }
      onToolsResolved(tools);
    } catch (e) {
      toolErrors = [
        { serverId: "request", error: e instanceof Error ? e.message : "Failed to resolve tools" },
      ];
      tools = [];
      onToolsResolved([]);
    } finally {
      loadingTools = false;
    }
  }

  /** Emit server changes and trigger tool resolution. */
  $effect(() => {
    const ids = [...selectedIds];
    onServersChange(ids);
    resolveTools(ids, env);
  });

  $effect(() => {
    fetchServers();
  });

  const selectedCount = $derived(selectedIds.size);
</script>

<div class="mcp-picker">
  <span class="section-label">MCP Servers</span>

  {#if loading}
    <div class="loading">Loading servers...</div>
  {:else if fetchError}
    <div class="error">
      <span>{fetchError}</span>
      <Button variant="secondary" size="small" onclick={fetchServers}>Retry</Button>
    </div>
  {:else if servers.length === 0}
    <div class="empty">No MCP servers available</div>
  {:else}
    <div class="server-list">
      {#each servers as server (server.id)}
        {@const checked = selectedIds.has(server.id)}
        <button
          class="server-item"
          class:selected={checked}
          onclick={() => toggleServer(server.id)}
          aria-pressed={checked}
        >
          <div class="server-header">
            <div class="checkbox" class:checked>
              {#if checked}
                <IconSmall.Check />
              {/if}
            </div>
            <span class="server-name">{server.name}</span>
            <span class="transport-badge">{server.transportType}</span>
          </div>
          {#if server.description}
            <p class="server-description">{server.description}</p>
          {/if}
        </button>
      {/each}
    </div>
  {/if}

  {#if selectedCount > 0}
    <div class="tools-section">
      <Collapsible.Root>
        <Collapsible.Trigger>
          {#snippet children(open)}
            <span class="tools-toggle-inner">
              <span class="chevron" class:expanded={open}>
                <IconSmall.CaretRight />
              </span>
              <span class="tools-label">
                {#if loadingTools}
                  Resolving tools...
                {:else}
                  {tools.length} {tools.length === 1 ? "tool" : "tools"} available
                {/if}
              </span>
            </span>
          {/snippet}
        </Collapsible.Trigger>

        {#if toolErrors.length > 0}
          <div class="tool-errors">
            {#each toolErrors as err (err.serverId)}
              <div class="tool-error">
                <span class="error-server">{err.serverId}:</span>
                <span>{err.error}</span>
              </div>
            {/each}
          </div>
        {/if}

        {#if tools.length > 0}
          <Collapsible.Content>
            <div class="tool-list">
              {#each tools as tool (tool.name)}
                <div class="tool-item">
                  <span class="tool-name">{tool.name}</span>
                  {#if tool.description}
                    <span class="tool-description">{tool.description}</span>
                  {/if}
                </div>
              {/each}
            </div>
          </Collapsible.Content>
        {/if}
      </Collapsible.Root>
    </div>
  {/if}
</div>

<style>
  .chevron {
    align-items: center;
    display: flex;
    flex-shrink: 0;
    transition: transform 0.15s;
  }

  .chevron :global(svg) {
    block-size: 12px;
    inline-size: 12px;
  }

  .chevron.expanded {
    transform: rotate(90deg);
  }

  .checkbox {
    align-items: center;
    background-color: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-1);
    block-size: 16px;
    display: flex;
    flex-shrink: 0;
    inline-size: 16px;
    justify-content: center;
    transition:
      border-color 0.1s,
      background-color 0.1s;
  }

  .checkbox :global(svg) {
    block-size: 12px;
    inline-size: 12px;
  }

  .checkbox.checked {
    background-color: var(--color-text);
    border-color: var(--color-text);
    color: var(--color-surface-1);
  }

  .empty {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-2);
  }

  .error {
    align-items: center;
    color: var(--color-error);
    display: flex;
    font-size: var(--font-size-2);
    gap: var(--size-2);
  }

  .error-server {
    font-weight: var(--font-weight-5);
  }

  .loading {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-2);
  }

  .mcp-picker {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .section-label {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    letter-spacing: var(--font-letterspacing-2);
    text-transform: uppercase;
  }

  .server-description {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-1);
    line-height: var(--font-lineheight-3);
    padding-inline-start: calc(16px + var(--size-2));
  }

  .server-header {
    align-items: center;
    display: flex;
    gap: var(--size-2);
  }

  .server-item {
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
    padding: var(--size-2);
    text-align: start;
    transition: border-color 0.1s;
  }

  .server-item:hover {
    border-color: color-mix(in srgb, var(--color-text), transparent 60%);
  }

  .server-item.selected {
    border-color: color-mix(in srgb, var(--color-text), transparent 40%);
  }

  .server-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-1-5);
  }

  .server-name {
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
  }

  .tool-description {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-1);
  }

  .tool-error {
    color: var(--color-error);
    font-size: var(--font-size-1);
  }

  .tool-errors {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  .tool-item {
    display: flex;
    flex-direction: column;
    gap: var(--size-0-5);
    padding-block: var(--size-1);
    padding-inline: var(--size-2);
  }

  .tool-list {
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    display: flex;
    flex-direction: column;
    max-block-size: 200px;
    overflow-y: auto;
  }

  .tool-name {
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
  }

  .tools-label {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
  }

  .tools-section {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .tools-section :global(button) {
    border-radius: var(--radius-1);
    color: var(--color-text);
    padding-block: var(--size-1);
    padding-inline: var(--size-1);
  }

  .tools-section :global(button:hover) {
    background-color: var(--color-highlight-1);
  }

  .tools-toggle-inner {
    align-items: center;
    display: flex;
    gap: var(--size-1);
  }

  .transport-badge {
    background-color: var(--color-highlight-1);
    border-radius: var(--radius-round);
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-size: var(--font-size-0);
    font-weight: var(--font-weight-5);
    letter-spacing: var(--font-letterspacing-1);
    padding-block: var(--size-0-5);
    padding-inline: var(--size-1-5);
    text-transform: uppercase;
  }
</style>
