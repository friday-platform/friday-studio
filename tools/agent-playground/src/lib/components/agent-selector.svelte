<script lang="ts">
  import { Button } from "@atlas/ui";
  import { getClient, type Client } from "$lib/client.ts";
  import type { InferResponseType } from "hono/client";

  type AgentsEndpoint = Client["api"]["agents"]["$get"];
  type AgentsResponse = InferResponseType<AgentsEndpoint>;
  type AgentMetadata = AgentsResponse["agents"][number];

  type Props = {
    onSelect: (agent: AgentMetadata | null) => void;
    onExampleClick?: (example: string) => void;
  };

  let { onSelect, onExampleClick }: Props = $props();

  let agents = $state<AgentMetadata[]>([]);
  let selectedId = $state("");
  let loading = $state(true);
  let error = $state<string | null>(null);

  const selected = $derived(agents.find((a) => a.id === selectedId) ?? null);

  $effect(() => {
    onSelect(selected);
  });

  async function fetchAgents() {
    loading = true;
    error = null;
    try {
      const res = await getClient().api.agents.$get();
      if (!res.ok) throw new Error(`Failed to fetch agents: ${res.status}`);
      const data = await res.json();
      agents = data.agents;
      if (agents.length > 0 && !selectedId) {
        selectedId = agents[0].id;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to fetch agents";
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    fetchAgents();
  });
</script>

<div class="agent-selector">
  <label class="section-label" for="agent-select">Agent</label>

  {#if loading}
    <div class="loading">Loading agents...</div>
  {:else if error}
    <div class="error">
      <span>{error}</span>
      <Button variant="secondary" size="small" onclick={fetchAgents}>Retry</Button>
    </div>
  {:else}
    <select id="agent-select" bind:value={selectedId}>
      {#each agents as agent (agent.id)}
        <option value={agent.id}>{agent.displayName}</option>
      {/each}
    </select>

    {#if selected}
      <div class="agent-meta">
        {#if selected.description}
          <p class="description">{selected.description}</p>
        {/if}

        {#if selected.constraints}
          <p class="constraints">{selected.constraints}</p>
        {/if}

        {#if selected.examples.length > 0}
          <div class="examples">
            <span class="examples-label">Examples</span>
            <div class="chip-list">
              {#each selected.examples.slice(0, 3) as example (example)}
                <Button variant="secondary" size="small" onclick={() => onExampleClick?.(example)}>
                  {example}
                </Button>
              {/each}
            </div>
          </div>
        {/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  .agent-meta {
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
    margin-block-start: var(--size-3);
  }

  .agent-selector {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .chip-list {
    display: flex;
    flex-wrap: wrap;
    gap: var(--size-1-5);
  }

  .constraints {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-1);
    font-style: italic;
    line-height: var(--font-lineheight-3);
  }

  .description {
    font-size: var(--font-size-2);
    line-height: var(--font-lineheight-3);
  }

  .error {
    align-items: center;
    color: var(--color-error);
    display: flex;
    font-size: var(--font-size-2);
    gap: var(--size-2);
  }

  .examples {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .examples-label {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    letter-spacing: var(--font-letterspacing-2);
    text-transform: uppercase;
  }

  .loading {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-2);
  }

  .section-label {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    letter-spacing: var(--font-letterspacing-2);
    text-transform: uppercase;
  }

  select {
    appearance: none;
    background-color: var(--color-surface-2);
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='none' viewBox='0 0 12 12'%3E%3Cpath stroke='%239ca3af' stroke-linecap='round' stroke-linejoin='round' stroke-width='1.5' d='m3 4.5 3 3 3-3'/%3E%3C/svg%3E");
    background-position: right var(--size-2) center;
    background-repeat: no-repeat;
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    font-size: var(--font-size-3);
    inline-size: 100%;
    padding-block: var(--size-2);
    padding-inline: var(--size-2-5);
    padding-inline-end: var(--size-8);
  }

  select:focus {
    border-color: color-mix(in srgb, var(--color-text), transparent 60%);
    outline: none;
  }
</style>
