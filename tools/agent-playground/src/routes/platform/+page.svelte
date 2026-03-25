<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import { goto } from "$app/navigation";
  import WorkspaceLoader from "$lib/components/workspace/workspace-loader.svelte";
  import { workspaceQueries } from "$lib/queries";

  const workspacesQuery = createQuery(() => workspaceQueries.enriched());
  const visibleWorkspaces = $derived(workspacesQuery.data ?? []);

  $effect(() => {
    if (visibleWorkspaces.length > 0 && visibleWorkspaces[0]) {
      goto(`/platform/${visibleWorkspaces[0].id}`, { replaceState: true });
    }
  });
</script>

<div class="onboarding">
  {#if workspacesQuery.isLoading}
    <p class="loading-hint">Loading workspaces...</p>
  {:else if visibleWorkspaces.length === 0}
    <h2 class="onboarding-title">Welcome to Friday</h2>
    <p class="onboarding-hint">Drop a workspace.yml to get started</p>
    <WorkspaceLoader inline />
  {/if}
</div>

<style>
  .onboarding {
    align-items: center;
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--size-3);
    justify-content: center;
    padding: var(--size-10);
  }

  .onboarding-title {
    font-size: var(--font-size-6);
    font-weight: var(--font-weight-6);
  }

  .onboarding-hint {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-3);
    margin-block-end: var(--size-4);
  }

  .loading-hint {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-3);
  }
</style>
