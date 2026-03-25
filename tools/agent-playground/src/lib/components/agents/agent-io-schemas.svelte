<!--
  I/O schema display for a bundled agent. Fetches from the playground's
  /api/agents endpoint (which includes schemas from the bundled registry)
  rather than the daemon proxy (which doesn't).

  Each instance shares the same TanStack Query cache key, so multiple
  cards don't cause redundant fetches.

  @component
  @param {string} agentId - Bundled agent registry ID (e.g. "gh", "claude-code")
-->

<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import SchemaPropertyTable from "$lib/components/shared/schema-property-table.svelte";
  import { agentQueries } from "$lib/queries";

  interface Props {
    agentId: string;
  }

  const { agentId }: Props = $props();

  /** Fetch all bundled agents (shared cache across all instances). */
  const agentsQuery = createQuery(() => agentQueries.bundledWithSchemas());

  const schemas = $derived.by(() => {
    const agents = agentsQuery.data;
    if (!agents) return null;
    const agent = agents.find((a) => a.id === agentId);
    if (!agent) return null;
    if (!agent.inputSchema && !agent.outputSchema) return null;
    return { input: agent.inputSchema ?? null, output: agent.outputSchema ?? null };
  });
</script>

{#if schemas?.input}
  <div class="detail-section">
    <h3 class="detail-label">Input Schema</h3>
    <SchemaPropertyTable schema={schemas.input as object | null} />
  </div>
{/if}

{#if schemas?.output}
  <div class="detail-section">
    <h3 class="detail-label">Output Schema</h3>
    <SchemaPropertyTable schema={schemas.output as object | null} />
  </div>
{/if}

<style>
  .detail-section {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .detail-label {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
  }
</style>
