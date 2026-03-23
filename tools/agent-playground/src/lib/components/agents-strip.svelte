<!--
  Horizontal strip of workspace-level agent cards.

  Renders above the pipeline diagram in the cockpit. Each card shows
  agent name, truncated description, and type badge. Scrolls horizontally
  when cards overflow.

  @component
  @param {import("@atlas/config/mutations").WorkspaceAgent[]} agents - Workspace agents to display
  @param {string | null} [selectedAgentId] - Currently selected agent ID
  @param {(agentId: string) => void} [onAgentClick] - Agent card click handler
-->

<script lang="ts">
  import type { WorkspaceAgent } from "@atlas/config/workspace-agents";

  type Props = {
    agents: WorkspaceAgent[];
    selectedAgentId?: string | null;
    onAgentClick?: (agentId: string) => void;
    /** Agent IDs to visually dim (not used by selected job in multi-job mode). */
    dimmedAgentIds?: Set<string>;
  };

  let { agents, selectedAgentId = null, onAgentClick, dimmedAgentIds }: Props = $props();

  /** Type badge label from agent config */
  function typeBadge(agent: WorkspaceAgent): string {
    if (agent.agent) return agent.agent;
    if (agent.type === "llm") return "LLM";
    return agent.type;
  }

  /**
   * Extract env key names that reference Link credentials (`from: "link"`).
   * Returns empty array when no link credentials are declared.
   */
  function linkCredentialKeys(agent: WorkspaceAgent): string[] {
    const keys: string[] = [];
    for (const [key, value] of Object.entries(agent.env)) {
      if (
        typeof value === "object" &&
        value !== null &&
        "from" in value &&
        value.from === "link"
      ) {
        keys.push(key);
      }
    }
    return keys;
  }
</script>

{#if agents.length > 0}
  <div class="agents-strip">
    {#each agents as agent (agent.id)}
      <button
        class="agent-card"
        class:agent-card--selected={selectedAgentId === agent.id}
        class:agent-card--dimmed={dimmedAgentIds?.has(agent.id)}
        onclick={() => onAgentClick?.(agent.id)}
      >
        <div class="card-header">
          <span class="card-name">
            {agent.name}
            {#if linkCredentialKeys(agent).length > 0}
              <span
                class="credential-dot"
                title="Credentials: {linkCredentialKeys(agent).join(', ')}"
              ></span>
            {/if}
          </span>
          <span class="card-badge">{typeBadge(agent)}</span>
        </div>
        {#if agent.description}
          <span class="card-description">{agent.description}</span>
        {/if}
      </button>
    {/each}
  </div>
{/if}

<style>
  .agents-strip {
    display: flex;
    gap: var(--size-2);
    overflow-x: auto;
    padding-block: var(--size-2);
  }

  .agent-card {
    background: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    cursor: pointer;
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    font-family: inherit;
    gap: var(--size-1);
    min-inline-size: 160px;
    max-inline-size: 220px;
    padding: var(--size-2) var(--size-3);
    text-align: start;
    transition:
      border-color 150ms ease,
      box-shadow 150ms ease;
  }

  .agent-card:hover {
    border-color: var(--color-border-2);
  }

  .agent-card--selected {
    border-color: var(--color-info);
    box-shadow: 0 0 0 1px var(--color-info);
  }

  .agent-card--dimmed {
    opacity: 0.4;
  }

  .card-header {
    align-items: center;
    display: flex;
    gap: var(--size-2);
    inline-size: 100%;
  }

  .card-name {
    color: var(--color-text);
    flex: 1;
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-6);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .credential-dot {
    background-color: color-mix(in srgb, var(--color-text), transparent 60%);
    block-size: 6px;
    border-radius: var(--radius-round);
    display: inline-block;
    flex-shrink: 0;
    inline-size: 6px;
    margin-inline-start: var(--size-1);
    vertical-align: middle;
  }

  .card-badge {
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

  .card-description {
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 1;
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    display: -webkit-box;
    font-size: var(--font-size-1);
    overflow: hidden;
  }
</style>
