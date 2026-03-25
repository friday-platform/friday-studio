<!--
  Empty-state workspace + job picker for the inspector page.

  Replaces the "Select a workspace and job" placeholder with a centered card
  showing each workspace's description and clickable job rows. Selecting a job
  navigates via URL search params, which the toolbar selector picks up.

  @component
-->

<script lang="ts">
  import { humanizeStepName } from "@atlas/config/pipeline-utils";
  import { IconSmall } from "@atlas/ui";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { useWorkspacesWithJobs } from "$lib/queries/workspaces-list";

  const query = useWorkspacesWithJobs();
  const workspaces = $derived(query.data ?? []);

  function selectJob(workspaceId: string, jobId: string) {
    const url = new URL(page.url);
    url.searchParams.set("workspace", workspaceId);
    url.searchParams.set("job", jobId);
    goto(url.toString(), { replaceState: true });
  }
</script>

<div class="picker">
  <div class="picker-header">
    <h2 class="picker-title">Run & inspect</h2>
    <p class="picker-subtitle">Pick a job to run it, watch it execute, and inspect each step.</p>
  </div>

  {#if query.isPending}
    <span class="status-text">Loading workspaces…</span>
  {:else if workspaces.length === 0}
    <span class="status-text">No workspaces found</span>
  {:else}
    {#each workspaces as ws (ws.id)}
      <div class="workspace-group">
        {#if ws.jobs.length > 0}
          <div class="workspace-card">
            <div class="workspace-card-header">
              <h3 class="workspace-name">{ws.displayName}</h3>
              {#if ws.description}
                <p class="workspace-description">{ws.description}</p>
              {/if}
            </div>
            {#each ws.jobs as job (job.id)}
              <button
                class="job-row"
                onclick={() => selectJob(ws.id, job.id)}
              >
                <span class="job-title">{job.title || humanizeStepName(job.id)}</span>
                <span class="job-arrow"><IconSmall.CaretRight /></span>
              </button>
            {/each}
          </div>
        {:else}
          <span class="status-text">No jobs configured</span>
        {/if}
      </div>
    {/each}
  {/if}
</div>

<style>
  .picker {
    display: flex;
    flex-direction: column;
    gap: var(--size-6);
    max-inline-size: 520px;
    inline-size: 100%;
  }

  .picker-header {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  .picker-title {
    font-size: var(--font-size-5);
    font-weight: var(--font-weight-6);
    color: var(--color-text);
    margin: 0;
  }

  .picker-subtitle {
    font-size: var(--font-size-2);
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    margin: 0;
    line-height: var(--font-lineheight-3);
  }

  .workspace-group {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .workspace-card {
    background: var(--color-surface-1);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-4);
    display: flex;
    flex-direction: column;
  }

  .workspace-card-header {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
    padding: var(--size-5) var(--size-6) var(--size-3);
  }

  .workspace-name {
    font-size: var(--font-size-4);
    font-weight: var(--font-weight-6);
    color: var(--color-text);
    margin: 0;
  }

  .workspace-description {
    color: color-mix(in srgb, var(--color-text), transparent 20%);
    font-size: var(--font-size-2);
    line-height: 1.5;
    margin: 0;
  }

  .job-row {
    align-items: center;
    background: none;
    border: none;
    border-block-end: 1px solid color-mix(in srgb, var(--color-border-1), transparent 50%);
    border-radius: 0;
    color: inherit;
    cursor: pointer;
    display: flex;
    font-family: inherit;
    font-size: var(--font-size-2);
    gap: var(--size-2);
    margin-inline: var(--size-3);
    padding: var(--size-2-5) var(--size-3);
    text-align: start;
    text-decoration: none;
    transition: background-color 120ms ease;
  }

  .job-row:last-child {
    border-block-end: none;
    margin-block-end: var(--size-3);
  }

  .job-row:hover {
    background: color-mix(in srgb, var(--color-text), transparent 93%);
    border-radius: var(--radius-2);
  }

  .job-title {
    font-weight: var(--font-weight-5);
    white-space: nowrap;
  }

  .job-arrow {
    color: color-mix(in srgb, var(--color-text), transparent 70%);
    display: flex;
    flex: none;
    margin-inline-start: auto;
    transition: color 120ms ease;
  }

  .job-row:hover .job-arrow {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
  }

  .status-text {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-1);
    font-family: var(--font-mono);
  }

  @media (prefers-reduced-motion: reduce) {
    .job-row { transition: none; }
    .job-arrow { transition: none; }
  }
</style>
