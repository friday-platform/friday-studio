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
  <header class="section-head">
    <h2 class="section-title">Jobs</h2>
    <span class="section-count">{jobs.length}</span>
    <a href="/platform/{workspaceId}/jobs" class="section-action">View all</a>
  </header>

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
    border-radius: var(--radius-4);
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
    min-inline-size: 0;
    padding: var(--size-4) var(--size-5);
  }

  .section-head {
    align-items: baseline;
    display: flex;
    gap: var(--size-2-5);
  }

  .section-title {
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-6);
    margin: 0;
  }

  .section-count {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-1);
  }

  .section-action {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-1);
    margin-inline-start: auto;
    text-decoration: none;
    transition: color 120ms ease;
  }

  .section-action:hover {
    color: var(--color-text);
  }

  .job-rows {
    display: flex;
    flex-direction: column;
  }

  .divider {
    border-block-start: 1px solid color-mix(in srgb, var(--color-border-1), transparent 30%);
  }
</style>
