<!--
  Workspace + job selector bar for the inspector page (Zone 1).

  Two dropdowns: workspace (populated from daemon API) and job (populated from
  the selected workspace's config). Selection is reflected in URL search params
  (`?workspace=X&job=Y`). Loading a URL with those params auto-selects both.

  @component
-->

<script lang="ts">
  import type { WorkspaceConfig } from "@atlas/config";
  import { humanizeStepName } from "@atlas/config/pipeline-utils";
  import { DropdownMenu, IconSmall } from "@atlas/ui";
  import { createQuery } from "@tanstack/svelte-query";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { workspaceQueries } from "$lib/queries";

  interface Props {
    onselection: (selection: {
      workspaceId: string | null;
      jobId: string | null;
      config: WorkspaceConfig | null;
    }) => void;
  }

  const { onselection }: Props = $props();

  const workspacesQuery = createQuery(() => workspaceQueries.enriched());
  const workspaces = $derived(workspacesQuery.data ?? []);

  /** URL is the single source of truth for selection state. */
  const workspaceId = $derived(page.url.searchParams.get("workspace"));
  const jobId = $derived(page.url.searchParams.get("job"));

  const configQuery = createQuery(() => workspaceQueries.config(workspaceId));
  const config = $derived(configQuery.data?.config ?? null);

  /** Display label for the workspace trigger button. */
  const workspaceLabel = $derived.by(() => {
    if (workspacesQuery.isPending) return "Loading…";
    if (workspacesQuery.isError) return "Error loading";
    if (workspaces.length === 0) return "No workspaces";
    if (!workspaceId) return "Select workspace";
    const match = workspaces.find((ws) => ws.id === workspaceId);
    return match?.displayName ?? workspaceId;
  });

  /** Derive job entries from the workspace config. */
  const jobEntries = $derived.by(() => {
    if (!config?.jobs) return [];
    return Object.entries(config.jobs).map(([id, job]) => {
      const title = job.title ?? humanizeStepName(id);
      return { id, title };
    });
  });

  /** Display label for the job trigger button. */
  const jobLabel = $derived.by(() => {
    if (!workspaceId) return "--";
    if (configQuery.isPending) return "Loading…";
    if (jobEntries.length === 0) return "No jobs";
    if (!jobId) return "Select job";
    const match = jobEntries.find((j) => j.id === jobId);
    return match?.title ?? jobId;
  });

  /** Auto-select the first job if the current jobId is invalid for this workspace. */
  $effect(() => {
    if (jobEntries.length === 0) return;
    const valid = jobEntries.some((j) => j.id === jobId);
    if (!valid && jobEntries[0]) {
      selectJob(jobEntries[0].id);
    }
  });

  /** Notify parent of selection changes. */
  $effect(() => {
    onselection({ workspaceId, jobId, config });
  });

  function selectWorkspace(id: string) {
    const url = new URL(page.url);
    url.searchParams.set("workspace", id);
    url.searchParams.delete("job");
    url.searchParams.delete("session");
    url.searchParams.delete("step");
    goto(url.toString(), { replaceState: true });
  }

  function selectJob(id: string) {
    const url = new URL(page.url);
    url.searchParams.set("job", id);
    url.searchParams.delete("session");
    url.searchParams.delete("step");
    goto(url.toString(), { replaceState: true });
  }
</script>

<div class="selector-bar">
  <div class="selector">
    <span class="selector-label">Workspace</span>
    <DropdownMenu.Root>
      <DropdownMenu.Trigger class="selector-trigger" aria-disabled={workspacesQuery.isPending}>
        <span class="trigger-text">{workspaceLabel}</span>
        <IconSmall.CaretDown />
      </DropdownMenu.Trigger>
      <DropdownMenu.Content>
        {#each workspaces as ws (ws.id)}
          <DropdownMenu.Item
            radio
            checked={ws.id === workspaceId}
            onclick={() => selectWorkspace(ws.id)}
          >
            {ws.displayName}
          </DropdownMenu.Item>
        {/each}
        {#if workspaces.length === 0 && !workspacesQuery.isPending}
          <DropdownMenu.Empty>No workspaces found</DropdownMenu.Empty>
        {/if}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  </div>

  <div class="selector">
    <span class="selector-label">Job</span>
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        class="selector-trigger"
        aria-disabled={!workspaceId || configQuery.isPending}
      >
        <span class="trigger-text">{jobLabel}</span>
        <IconSmall.CaretDown />
      </DropdownMenu.Trigger>
      <DropdownMenu.Content>
        {#each jobEntries as job (job.id)}
          <DropdownMenu.Item radio checked={job.id === jobId} onclick={() => selectJob(job.id)}>
            {job.title}
          </DropdownMenu.Item>
        {/each}
        {#if jobEntries.length === 0 && workspaceId && !configQuery.isPending}
          <DropdownMenu.Empty>No jobs configured</DropdownMenu.Empty>
        {/if}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  </div>

  {#if configQuery.isPending && workspaceId}
    <span class="loading-indicator">Loading config…</span>
  {/if}
</div>

<style>
  .selector-bar {
    align-items: center;
    block-size: 100%;
    display: flex;
    gap: var(--size-4);
    padding-inline: var(--size-4);
  }

  .selector {
    align-items: center;
    display: flex;
    gap: var(--size-2);
  }

  .selector-label {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    white-space: nowrap;
  }

  :global(.selector-trigger) {
    align-items: center;
    background: color-mix(in srgb, var(--color-surface), transparent 50%);
    border: 1px solid color-mix(in srgb, var(--color-text), transparent 85%);
    border-radius: var(--radius-2);
    color: var(--color-text);
    cursor: default;
    display: inline-flex;
    font-family: inherit;
    font-size: var(--font-size-1);
    gap: var(--size-2);
    min-inline-size: 160px;
    padding-block: var(--size-1);
    padding-inline: var(--size-2);
  }

  :global(.selector-trigger:disabled) {
    cursor: not-allowed;
    opacity: 0.5;
  }

  .trigger-text {
    flex: 1;
    text-align: start;
  }

  .loading-indicator {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-0);
    font-style: italic;
  }
</style>
