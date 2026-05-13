<!--
  A single agent row in the catalog with an expandable inline spec sheet.

  Collapsed: health dot, display name, type badge, truncated description,
  version, "Test →" link. Clicking the row (not "Test →") toggles expansion.

  Expanded: full description, constraints, example prompt chips,
  input/output schema tables, required/optional config summary with health dots.

  @component
  @param {AgentMetadata} agent - Agent metadata from the /api/agents endpoint
  @param {"connected" | "disconnected" | "unknown"} [health] - Override credential health (auto-fetched if omitted)
  @param {boolean} expanded - Whether the spec sheet is expanded
  @param {() => void} onToggle - Fires when the row is clicked to toggle expansion
  @param {(agentId: string) => void} onNavigate - Fires when "Test →" is clicked
  @param {(example: string) => void} [onExampleClick] - Fires when an example chip is clicked
-->

<script lang="ts">
  import { Button } from "@atlas/ui";
  import { createQuery } from "@tanstack/svelte-query";
  import type { Client } from "$lib/client.ts";
  import { agentQueries } from "$lib/queries";
  import type { InferResponseType } from "hono/client";
  import InlineBadge from "$lib/components/shared/inline-badge.svelte";
  import AgentIoSchemas from "./agent-io-schemas.svelte";

  type AgentsEndpoint = Client["api"]["agents"]["$get"];
  type AgentsResponse = InferResponseType<AgentsEndpoint>;
  type AgentMetadata = AgentsResponse["agents"][number];

  type Props = {
    agent: AgentMetadata;
    health?: "connected" | "disconnected" | "unknown";
    expanded: boolean;
    onToggle: () => void;
    onNavigate: (agentId: string) => void;
    onExampleClick?: (example: string) => void;
  };

  let {
    agent,
    health: healthOverride,
    expanded,
    onToggle,
    onNavigate,
    onExampleClick,
  }: Props = $props();

  /** Self-fetch preflight when no health override is provided. */
  const preflightQuery = createQuery(() => ({
    ...agentQueries.preflight(agent.id),
    enabled: !healthOverride,
  }));
  const fetchedHealth = $derived.by((): "connected" | "disconnected" | "unknown" => {
    const creds = preflightQuery.data?.credentials;
    if (!creds) return "unknown";
    if (creds.length === 0) return "connected";
    return creds.some((c) => c.required && c.status === "disconnected")
      ? "disconnected"
      : "connected";
  });
  const health = $derived(healthOverride ?? fetchedHealth);

  const requiredConfig = $derived(agent.requiredConfig);
  const optionalConfig = $derived(agent.optionalConfig);
  const hasConfig = $derived(requiredConfig.length > 0 || optionalConfig.length > 0);
</script>

<div class="catalog-row" class:expanded role="row">
  <button class="row-header" onclick={onToggle} aria-expanded={expanded} type="button">
    <span
      class="health-dot"
      class:connected={health === "connected"}
      class:disconnected={health === "disconnected"}
      class:unknown={health === "unknown"}
      title={health === "connected"
        ? "Credentials configured"
        : health === "disconnected"
          ? "Missing credentials"
          : "Unknown status"}
    ></span>

    <span class="agent-name">{agent.displayName}</span>

    {#if agent.source === "user"}
      <InlineBadge variant="info">USER</InlineBadge>
    {:else}
      <InlineBadge variant="success">BUILT-IN</InlineBadge>
    {/if}

    {#if agent.description}
      <span class="description-truncated">{agent.description}</span>
    {/if}

    <code class="version">{agent.version}</code>
  </button>

  <a
    class="test-link"
    href="/agents/built-in/{encodeURIComponent(agent.id)}"
    onclick={(e) => {
      e.preventDefault();
      onNavigate(agent.id);
    }}
  >
    Test &rarr;
  </a>
</div>

{#if expanded}
  <div class="spec-sheet" role="region" aria-label="Spec sheet for {agent.displayName}">
    {#if agent.description}
      <div class="spec-section">
        <h3 class="spec-label">Description</h3>
        <p class="spec-description">{agent.description}</p>
      </div>
    {/if}

    {#if agent.constraints}
      <div class="spec-section">
        <h3 class="spec-label">Constraints</h3>
        <p class="spec-constraints">{agent.constraints}</p>
      </div>
    {/if}

    {#if agent.examples.length > 0}
      <div class="spec-section">
        <h3 class="spec-label">Examples</h3>
        <div class="chip-list">
          {#each agent.examples as example, i (i)}
            <Button variant="secondary" size="small" onclick={() => onExampleClick?.(example)}>
              {example}
            </Button>
          {/each}
        </div>
      </div>
    {/if}

    <AgentIoSchemas agentId={agent.id} />

    {#if hasConfig}
      <div class="spec-section">
        <h3 class="spec-label">Configuration</h3>
        <div class="config-list">
          {#each requiredConfig as cfg (cfg.key)}
            <div class="config-entry">
              <span class="config-dot required"></span>
              <code class="config-key">{cfg.key}</code>
              <span class="config-required-label">required</span>
              {#if cfg.description}
                <span class="config-desc">{cfg.description}</span>
              {/if}
            </div>
          {/each}
          {#each optionalConfig as cfg (cfg.key)}
            <div class="config-entry">
              <span class="config-dot optional"></span>
              <code class="config-key">{cfg.key}</code>
              <span class="config-optional-label">optional</span>
              {#if cfg.description}
                <span class="config-desc">{cfg.description}</span>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    {/if}
  </div>
{/if}

<style>
  .catalog-row {
    align-items: center;
    border-block-end: 1px solid var(--color-border-1);
    display: flex;
    gap: var(--size-3);
    min-block-size: var(--size-10);
    padding-inline: var(--size-4);
  }

  .catalog-row:hover {
    background-color: color-mix(in srgb, var(--color-surface-2), transparent 50%);
  }

  .catalog-row.expanded {
    border-block-end-color: transparent;
  }

  .row-header {
    align-items: center;
    background: none;
    border: none;
    color: var(--color-text);
    cursor: pointer;
    display: flex;
    flex: 1;
    gap: var(--size-3);
    min-inline-size: 0;
    padding-block: var(--size-2-5);
    padding-inline: 0;
    text-align: start;
  }

  .row-header:focus-visible {
    outline: 2px solid var(--color-focus, currentColor);
    outline-offset: 2px;
  }

  .health-dot {
    background-color: color-mix(in srgb, var(--color-text), transparent 70%);
    block-size: 7px;
    border-radius: 50%;
    flex-shrink: 0;
    inline-size: 7px;
  }

  .health-dot.connected {
    background-color: var(--color-success);
  }

  .health-dot.disconnected {
    background-color: var(--color-error);
  }

  .health-dot.unknown {
    background-color: color-mix(in srgb, var(--color-text), transparent 70%);
  }

  .agent-name {
    flex-shrink: 0;
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-5);
    white-space: nowrap;
  }

  .description-truncated {
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    flex: 1;
    font-size: var(--font-size-2);
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .version {
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    flex-shrink: 0;
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-1);
  }

  .test-link {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    flex-shrink: 0;
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    text-decoration: none;
    white-space: nowrap;
  }

  .test-link:hover {
    color: var(--color-text);
  }

  .spec-sheet {
    background-color: color-mix(in srgb, var(--color-surface-2), transparent 60%);
    border-block-end: 1px solid var(--color-border-1);
    display: flex;
    flex-direction: column;
    gap: var(--size-4);
    padding-block: var(--size-4);
    padding-inline: var(--size-4) var(--size-4);
    padding-inline-start: calc(var(--size-4) + 7px + var(--size-3));
  }

  .spec-section {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .spec-label {
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    letter-spacing: var(--font-letterspacing-2);
    text-transform: uppercase;
  }

  .spec-description {
    font-size: var(--font-size-2);
    line-height: var(--font-lineheight-3);
  }

  .spec-constraints {
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    font-size: var(--font-size-2);
    font-style: italic;
    line-height: var(--font-lineheight-3);
  }

  .chip-list {
    display: flex;
    flex-wrap: wrap;
    gap: var(--size-1-5);
  }

  .chip-list :global(button) {
    justify-content: flex-start;
    max-inline-size: 100%;
  }

  .chip-list :global(button > span) {
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .config-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-1-5);
  }

  .config-entry {
    align-items: baseline;
    display: flex;
    gap: var(--size-2);
  }

  .config-dot {
    background-color: color-mix(in srgb, var(--color-text), transparent 70%);
    block-size: 6px;
    border-radius: 50%;
    flex-shrink: 0;
    inline-size: 6px;
    position: relative;
    top: -1px;
  }

  .config-dot.required {
    background-color: var(--color-error);
  }

  .config-dot.optional {
    background-color: color-mix(in srgb, var(--color-text), transparent 60%);
  }

  .config-key {
    color: var(--color-text);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
  }

  .config-required-label {
    color: var(--color-error);
    font-size: var(--font-size-1);
  }

  .config-optional-label {
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    font-size: var(--font-size-1);
  }

  .config-desc {
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    font-size: var(--font-size-2);
  }
</style>
