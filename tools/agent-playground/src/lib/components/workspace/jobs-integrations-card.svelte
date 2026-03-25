<!--
  Combined Jobs + Integrations card for the workspace overview.

  Shows job rows with run buttons and overflow menus on top, a visual
  divider, and integration credential status below.

  @component
  @param {string} workspaceId - Active workspace ID
  @param {{ id: string; title: string; description: string | null; triggers: { signal: string }[] }[]} jobs - Job summaries
  @param {Record<string, { description: string; title?: string; schema?: Record<string, unknown> }>} signals - Workspace signals keyed by ID
-->
<script lang="ts">
  import IntegrationsSidebar from "$lib/components/workspace/integrations-sidebar.svelte";
  import JobsCardRow from "$lib/components/workspace/jobs-card-row.svelte";

  type Props = {
    workspaceId: string;
    jobs: {
      id: string;
      title: string;
      description: string | null;
      triggers: { signal: string }[];
    }[];
    signals: Record<
      string,
      { description: string; title?: string; schema?: Record<string, unknown> }
    >;
  };

  let { workspaceId, jobs, signals }: Props = $props();
</script>

<section class="card">
  <div class="card-header">
    <h2 class="card-title">Jobs</h2>
    <p class="card-lede">Signal-driven workflows that coordinate your agents.</p>
  </div>

  <div class="job-rows">
    {#each jobs as job (job.id)}
      <JobsCardRow {workspaceId} {job} {signals} />
    {/each}
  </div>

  <div class="divider"></div>

  <IntegrationsSidebar {workspaceId} />
</section>

<style>
  .card {
    background: var(--color-surface-1);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-3);
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
    min-inline-size: 0;
    padding: var(--size-4) var(--size-5);
  }

  .card-header {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  .card-title {
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-5);
    margin: 0;
  }

  .card-lede {
    color: color-mix(in srgb, var(--color-text), transparent 55%);
    font-size: var(--font-size-1);
    margin: 0;
  }

  .job-rows {
    display: flex;
    flex-direction: column;
    padding-block-start: var(--size-5);
  }

  .divider {
    border-block-start: 1px solid var(--color-border-1);
  }
</style>
