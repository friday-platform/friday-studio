<!--
  Two-mode router for the built-in agents page.

  - /agents/built-in        -> AgentCatalog (discovery)
  - /agents/built-in/{id}   -> AgentWorkbench (testing)

  Fetches agents list and credential preflight at page level.
  Routes to the appropriate sub-component based on URL params.

  @component
-->

<script lang="ts">
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import AgentCatalog from "$lib/components/agents/agent-catalog.svelte";
  import AgentWorkbench from "$lib/components/agents/agent-workbench.svelte";
  import { listenForOAuthCallback, startAppInstallFlow, startOAuthFlow } from "$lib/oauth-popup.ts";
  import { agentQueries, invalidateAgentPreflight } from "$lib/queries";

  const queryClient = useQueryClient();
  const agentsQuery = createQuery(() => agentQueries.list());
  const agents = $derived(agentsQuery.data ?? []);

  /** Resolve selected agent from URL param. */
  const selectedAgent = $derived(
    page.params.agentId ? (agents.find((a) => a.id === page.params.agentId) ?? null) : null,
  );

  /** Reactive agent ID for the preflight hook. */
  const selectedAgentId = $derived(selectedAgent?.id ?? null);
  const preflightQuery = createQuery(() => agentQueries.preflight(selectedAgentId));
  const credentials = $derived(preflightQuery.data?.credentials ?? []);

  /** Set up OAuth callback listener. */
  let cleanupOAuthListener: (() => void) | undefined;

  $effect(() => {
    cleanupOAuthListener = listenForOAuthCallback(() => {
      if (selectedAgentId) {
        invalidateAgentPreflight(queryClient, selectedAgentId);
      }
    });
    return () => cleanupOAuthListener?.();
  });

  function handleOAuthConnect(provider: string) {
    startOAuthFlow(provider);
  }

  function handleApiKeyConnect(_provider: string) {
    startAppInstallFlow(_provider);
  }

  function handleBack() {
    goto("/agents/built-in");
  }
</script>

{#if agentsQuery.isLoading}
  <div class="loading">Loading agents...</div>
{:else if agentsQuery.isError}
  <div class="error">Failed to load agents</div>
{:else if selectedAgent}
  {#key selectedAgent.id}
    <AgentWorkbench
      agent={selectedAgent}
      {credentials}
      onBack={handleBack}
      onOAuthConnect={handleOAuthConnect}
      onApiKeyConnect={handleApiKeyConnect}
    />
  {/key}
{:else}
  <AgentCatalog {agents} />
{/if}

<style>
  .loading {
    align-items: center;
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    display: flex;
    font-size: var(--font-size-3);
    block-size: 100%;
    justify-content: center;
  }

  .error {
    align-items: center;
    color: var(--color-error);
    display: flex;
    font-size: var(--font-size-3);
    block-size: 100%;
    justify-content: center;
  }
</style>
