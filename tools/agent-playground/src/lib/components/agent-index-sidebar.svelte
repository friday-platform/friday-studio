<!--
  Compact agent index for the right sidebar on the agents page.
  Each row shows health dot, agent name, and type badge, linking to
  the corresponding agent card via hash navigation.

  @component
  @param {WorkspaceAgent[]} agents - Workspace agents from deriveWorkspaceAgents
  @param {Map<string, IntegrationStatus>} providerStatus - Provider health from preflight query
-->

<script lang="ts">
  import type { WorkspaceAgent } from "@atlas/config/workspace-agents";
  import type { IntegrationStatus } from "$lib/queries/integrations-preflight";

  type Props = {
    agents: WorkspaceAgent[];
    providerStatus: Map<string, IntegrationStatus>;
  };

  let { agents, providerStatus }: Props = $props();

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
   * Determine health status for an agent based on its providers.
   * Returns the worst status, or null if no link credentials.
   */
  function agentHealth(agent: WorkspaceAgent): IntegrationStatus | null {
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

  function typeBadge(agent: WorkspaceAgent): string {
    if (agent.type === "atlas" || agent.agent) return "BUILT-IN";
    if (agent.type === "llm") return "CUSTOM";
    return agent.type;
  }

  function healthTitle(status: IntegrationStatus): string {
    switch (status) {
      case "connected": return "Credentials connected";
      case "degraded": return "Credentials degraded";
      case "disconnected": return "Credentials not connected";
    }
  }
</script>

{#if agents.length > 0}
  <div class="agent-index">
    <section class="explainer">
      <h3 class="section-title">Agent types</h3>
      <div class="type-list">
        <p class="type-entry">
          <strong>Built-in</strong> agents ship with Friday — tested, versioned, and ready to use.
        </p>
        <p class="type-entry">
          <strong>Custom</strong> agents are defined in your workspace config with a model, tools, and prompt.
        </p>
      </div>
      <a class="learn-more" href="https://fridayagent.ai/docs/agents">Learn more →</a>
    </section>

    <div class="section-header">
      <h3 class="section-title">Agents</h3>
      <span class="section-badge">{agents.length}</span>
    </div>
    <div class="entries">
      {#each agents as agent (agent.id)}
        {@const health = agentHealth(agent)}
        <a class="entry" href="#agent-{agent.id}">
          {#if health !== null}
            <span
              class="health-dot"
              class:connected={health === "connected"}
              class:degraded={health === "degraded"}
              class:disconnected={health === "disconnected"}
              title={healthTitle(health)}
            ></span>
          {:else}
            <span class="health-dot-placeholder"></span>
          {/if}
          <span class="agent-name">{agent.name}</span>
          {#if agent.agent}
            <span class="agent-impl">{agent.agent}</span>
          {/if}
          <span class="type-badge" class:custom={agent.type === "llm"}>{typeBadge(agent)}</span>
        </a>
      {/each}
    </div>
  </div>
{/if}

<style>
  .agent-index {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    padding-block-start: var(--size-10);
  }

  .section-header {
    align-items: baseline;
    display: flex;
    gap: var(--size-2);
  }

  .section-title {
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-5);
    margin: 0;
  }

  .section-badge {
    color: color-mix(in srgb, var(--color-text), transparent 60%);
    font-size: var(--font-size-0);
    font-variant-numeric: tabular-nums;
    margin-inline-start: auto;
  }

  .entries {
    display: flex;
    flex-direction: column;
  }

  .entry {
    align-items: center;
    color: inherit;
    display: flex;
    gap: var(--size-2);
    padding-block: var(--size-1-5);
    text-decoration: none;
  }

  .entry:not(:last-child) {
    border-block-end: 1px solid color-mix(in srgb, var(--color-border-1), transparent 50%);
  }

  .entry:hover {
    background-color: color-mix(in srgb, var(--color-surface-2), transparent 50%);
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

  .health-dot-placeholder {
    flex-shrink: 0;
    inline-size: 6px;
  }

  .agent-name {
    color: var(--color-text);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .explainer {
    border-block-end: 1px solid color-mix(in srgb, var(--color-border-1), transparent 50%);
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
    padding-block-end: var(--size-3);
  }

  .type-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .type-entry {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-size: var(--font-size-1);
    line-height: 1.5;
    margin: 0;
  }

  .learn-more {
    color: var(--color-info);
    font-size: var(--font-size-1);
    text-decoration: none;
  }

  .learn-more:hover {
    text-decoration: underline;
  }

  .agent-impl {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-00);
  }

  .type-badge {
    background-color: color-mix(in srgb, var(--color-success), transparent 90%);
    border-radius: var(--radius-1);
    color: var(--color-success);
    flex-shrink: 0;
    font-family: var(--font-family-monospace);
    font-size: 9px;
    font-weight: var(--font-weight-5);
    letter-spacing: var(--font-letterspacing-1);
    margin-inline-start: auto;
    padding: 2px var(--size-1);
    text-transform: uppercase;
  }

  .type-badge.custom {
    background-color: color-mix(in srgb, var(--color-info), transparent 85%);
    color: var(--color-info);
  }
</style>
