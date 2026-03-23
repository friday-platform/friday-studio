<!--
  Dashboard card for workspace agents (overview page).

  Each row shows: preflight health dot, agent name + type badge, LLM config
  strip (for LLM agents), tool pills (MCP server names), and an overflow menu.
  Rows link to the agents detail page.

  @component
  @param {import("@atlas/config/workspace-agents").WorkspaceAgent[]} agents - Workspace agents
  @param {string} workspaceId - Current workspace ID
-->

<script lang="ts">
  import type { WorkspaceAgent } from "@atlas/config/workspace-agents";
  import { DropdownMenu } from "@atlas/ui";
  import { goto } from "$app/navigation";
  import { useIntegrationsPreflight, type IntegrationStatus } from "$lib/queries/integrations-preflight";

  type Props = {
    agents: WorkspaceAgent[];
    workspaceId: string;
  };

  let { agents, workspaceId }: Props = $props();

  const preflightQuery = useIntegrationsPreflight(() => workspaceId);

  /** Provider -> status lookup from preflight data. */
  const providerStatus = $derived.by((): Map<string, IntegrationStatus> => {
    const map = new Map<string, IntegrationStatus>();
    for (const entry of preflightQuery.data?.integrations ?? []) {
      map.set(entry.provider, entry.status);
    }
    return map;
  });

  /** Type badge label from agent config. */
  function typeBadge(agent: WorkspaceAgent): string {
    if (agent.agent) return agent.agent;
    if (agent.type === "llm") return "LLM";
    return agent.type;
  }

  /**
   * Extract provider names from agent env vars (link refs only).
   */
  function agentProviders(agent: WorkspaceAgent): string[] {
    const providers: string[] = [];
    for (const [, value] of Object.entries(agent.env)) {
      if (
        typeof value === "object" &&
        value !== null &&
        "from" in value &&
        (value as Record<string, unknown>).from === "link"
      ) {
        const provider = (value as Record<string, unknown>).provider ?? (value as Record<string, unknown>).id;
        if (typeof provider === "string") providers.push(provider);
      }
    }
    return providers;
  }

  /**
   * Determine the health status for an agent based on its providers.
   * Returns the worst status across all providers, or null if no link credentials.
   */
  function healthStatus(agent: WorkspaceAgent): IntegrationStatus | null {
    const providers = agentProviders(agent);
    if (providers.length === 0) return null;

    const STATUS_PRIORITY: Record<IntegrationStatus, number> = {
      connected: 2,
      degraded: 1,
      disconnected: 0,
    };

    let worst: IntegrationStatus = "connected";
    for (const p of providers) {
      const status = providerStatus.get(p) ?? "disconnected";
      if (STATUS_PRIORITY[status] < STATUS_PRIORITY[worst]) {
        worst = status;
      }
    }
    return worst;
  }

  /** Build the LLM config strip text (e.g. "anthropic / claude-sonnet-4-6 · temp 0.3"). */
  function configStrip(agent: WorkspaceAgent): string | null {
    if (agent.type !== "llm") return null;
    const parts: string[] = [];
    if (agent.provider) parts.push(agent.provider);
    if (agent.model) parts.push(agent.model);
    if (parts.length === 0) return null;
    let strip = parts.join(" / ");
    if (agent.temperature !== undefined) {
      strip += ` · temp ${agent.temperature}`;
    }
    return strip;
  }

  function healthTitle(status: IntegrationStatus): string {
    switch (status) {
      case "connected": return "Credentials connected";
      case "degraded": return "Credentials degraded";
      case "disconnected": return "Credentials not connected";
    }
  }

  function handleViewAgent() {
    goto(`/platform/${workspaceId}/agents`);
  }
</script>

<div class="card">
  <div class="card-header">
    <h3 class="card-title">Agents</h3>
    <p class="card-lede">Jobs dispatch tasks to these workers.</p>
  </div>

  <div class="rows">
    {#each agents as agent (agent.id)}
      {@const status = healthStatus(agent)}
      {@const config = configStrip(agent)}
      {@const tools = agent.tools ?? []}
      <a class="row" href="/platform/{workspaceId}/agents">
        <div class="row-top">
          {#if status !== null}
            <span
              class="health-dot"
              class:connected={status === "connected"}
              class:degraded={status === "degraded"}
              class:disconnected={status === "disconnected"}
              title={healthTitle(status)}
            ></span>
          {/if}

          <span class="agent-name">{agent.name}</span>
          <span class="type-badge">{typeBadge(agent)}</span>

          {#if config}
            <span class="config-strip">{config}</span>
          {/if}

          {#if tools.length > 0}
            <span class="tool-pills">
              {#each tools as tool (tool)}
                <span class="tool-pill">{tool}</span>
              {/each}
            </span>
          {/if}

          {#if status !== null}
            <span class="health-label" class:connected={status === "connected"} class:degraded={status === "degraded"}>
              {healthTitle(status).replace("Credentials ", "")}
            </span>
          {/if}

          <DropdownMenu.Root positioning={{ placement: "bottom-end" }}>
            {#snippet children()}
              <DropdownMenu.Trigger class="overflow-btn" aria-label="Agent options" onclick={(e: MouseEvent) => e.preventDefault()}>
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
                  <circle cx="8" cy="3" r="1" />
                  <circle cx="8" cy="8" r="1" />
                  <circle cx="8" cy="13" r="1" />
                </svg>
              </DropdownMenu.Trigger>

              <DropdownMenu.Content>
                <DropdownMenu.Item onclick={handleViewAgent}>
                  View agent
                </DropdownMenu.Item>
                <DropdownMenu.Item onclick={() => goto(`/platform/${workspaceId}/edit?path=agents.${agent.id}`)}>
                  Edit configuration
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            {/snippet}
          </DropdownMenu.Root>
        </div>
        {#if agent.description}
          <p class="agent-description">{agent.description}</p>
        {/if}
      </a>
    {/each}
  </div>
</div>

<style>
  .card {
    background: var(--color-surface-1);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-3);
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
    padding: var(--size-4) var(--size-5);
  }

  .card-header {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  .card-title {
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-5);
    margin: 0;
  }

  .card-lede {
    color: color-mix(in srgb, var(--color-text), transparent 55%);
    font-size: var(--font-size-1);
    margin: 0;
  }

  .rows {
    display: flex;
    flex-direction: column;
  }

  .row {
    color: inherit;
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
    padding-block: var(--size-2);
    text-decoration: none;
    transition: background-color 120ms ease;
  }

  .row-top {
    align-items: center;
    display: flex;
    gap: var(--size-2);
  }

  .row:not(:last-child) {
    border-block-end: 1px solid color-mix(in srgb, var(--color-border-1), transparent 50%);
  }

  .row:hover {
    background-color: color-mix(in srgb, var(--color-text), transparent 96%);
  }

  .agent-description {
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 1;
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    display: -webkit-box;
    font-size: var(--font-size-1);
    line-height: var(--font-lineheight-2);
    margin: 0;
    overflow: hidden;
    padding-inline-start: var(--size-3-5);
  }

  .health-label {
    color: color-mix(in srgb, var(--color-text), transparent 55%);
    font-size: var(--font-size-0);
    margin-inline-start: auto;
    white-space: nowrap;
  }

  .health-label.connected {
    color: color-mix(in srgb, var(--color-text), transparent 45%);
  }

  .health-label.degraded {
    color: var(--color-warning);
  }

  .row :global(.overflow-btn) {
    align-items: center;
    block-size: var(--size-6);
    border-radius: var(--radius-1);
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    display: flex;
    flex-shrink: 0;
    inline-size: var(--size-6);
    justify-content: center;
    opacity: 0;
    padding: 0;
    transition: opacity 120ms ease;
  }

  .row:hover :global(.overflow-btn) {
    opacity: 1;
  }

  :global(.overflow-btn):hover {
    background: color-mix(in srgb, var(--color-text), transparent 90%);
    color: var(--color-text);
  }

  :global(.overflow-btn) svg {
    block-size: 16px;
    inline-size: 16px;
  }

  .health-dot {
    background-color: color-mix(in srgb, var(--color-text), transparent 70%);
    block-size: 6px;
    border-radius: 50%;
    flex-shrink: 0;
    inline-size: 6px;
  }

  .health-dot.connected {
    background-color: var(--color-success);
  }

  .health-dot.degraded {
    background-color: var(--color-warning);
  }

  .health-dot.disconnected {
    background-color: var(--color-error);
  }

  .agent-name {
    color: var(--color-text);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .type-badge {
    background-color: color-mix(in srgb, var(--color-success), transparent 85%);
    border-radius: var(--radius-1);
    color: var(--color-success);
    flex-shrink: 0;
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-0);
    font-weight: var(--font-weight-5);
    letter-spacing: var(--font-letterspacing-1);
    padding: var(--size-0-5) var(--size-1);
    text-transform: uppercase;
  }

  .config-strip {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    flex-shrink: 1;
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-0);
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tool-pills {
    align-items: center;
    display: flex;
    flex-shrink: 0;
    gap: var(--size-1);
  }

  .tool-pill {
    background-color: color-mix(in srgb, var(--color-info), transparent 88%);
    border-radius: var(--radius-1);
    color: var(--color-info);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-0);
    font-weight: var(--font-weight-5);
    padding: var(--size-0-5) var(--size-1);
    white-space: nowrap;
  }
</style>
