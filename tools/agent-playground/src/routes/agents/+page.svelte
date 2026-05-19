<!--
  Combined agent catalog: bundled + user agents.

  /agents             → catalog (all agents)
  /agents/built-in/:id → workbench (any agent type)
-->

<script lang="ts">
  import { PageLayout } from "@atlas/ui";
  import { createQuery } from "@tanstack/svelte-query";
  import AgentCatalog from "$lib/components/agents/agent-catalog.svelte";
  import { agentQueries } from "$lib/queries";

  const agentsQuery = createQuery(() => agentQueries.list());
  const agents = $derived(agentsQuery.data ?? []);
</script>

<PageLayout.Root>
  <PageLayout.Title subtitle="Inspect and run bundled agents">Agents</PageLayout.Title>
  <PageLayout.Body>
    <PageLayout.Content>
      {#if agentsQuery.isLoading}
        <div class="loading">Loading agents...</div>
      {:else if agentsQuery.isError}
        <div class="error">Failed to load agents</div>
      {:else}
        <AgentCatalog {agents} />
      {/if}
    </PageLayout.Content>
  </PageLayout.Body>
</PageLayout.Root>

<style>
  .loading,
  .error {
    align-items: center;
    display: flex;
    block-size: 100%;
    justify-content: center;
    color: color-mix(in srgb, var(--color-text), transparent 40%);
  }
</style>
