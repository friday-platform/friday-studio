<!--
  Horizontal pill strip for selecting between jobs in multi-job workspaces.

  Only renders when 2+ jobs exist. Each pill shows job title/name and step count.
  Selected job has highlighted border. Emits selected job ID on click.

  @component
  @param {JobInfo[]} jobs - Job metadata
  @param {string | null} selectedJobId - Currently selected job ID
  @param {(jobId: string) => void} [onJobSelect] - Job selection handler
-->

<script module lang="ts">
  export interface JobInfo {
    id: string;
    title: string;
    stepCount: number;
  }
</script>

<script lang="ts">
  type Props = {
    jobs: JobInfo[];
    selectedJobId: string | null;
    onJobSelect?: (jobId: string) => void;
  };

  let { jobs, selectedJobId, onJobSelect }: Props = $props();
</script>

{#if jobs.length > 1}
  <div class="job-selector">
    {#each jobs as job (job.id)}
      <button
        class="job-pill"
        class:job-pill--selected={selectedJobId === job.id}
        onclick={() => onJobSelect?.(job.id)}
      >
        <span class="job-name">{job.title}</span>
        <span class="step-count">{job.stepCount}</span>
      </button>
    {/each}
  </div>
{/if}

<style>
  .job-selector {
    border-block-end: 1px solid var(--color-border-1);
    display: flex;
    gap: var(--size-2);
    overflow-x: auto;
    padding: var(--size-2) var(--size-4);
  }

  .job-pill {
    align-items: center;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-round);
    cursor: pointer;
    display: flex;
    flex-shrink: 0;
    font-family: inherit;
    gap: var(--size-1-5);
    padding: var(--size-1) var(--size-3);
    transition:
      border-color 150ms ease,
      box-shadow 150ms ease;
  }

  .job-pill:hover {
    border-color: var(--color-border-2);
  }

  .job-pill--selected {
    border-color: var(--color-info);
    box-shadow: 0 0 0 1px var(--color-info);
  }

  .job-name {
    color: var(--color-text);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    white-space: nowrap;
  }

  .step-count {
    background-color: color-mix(in srgb, var(--color-text), transparent 85%);
    border-radius: var(--radius-round);
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-size: var(--font-size-0);
    font-weight: var(--font-weight-5);
    min-inline-size: 18px;
    padding: 0 var(--size-1);
    text-align: center;
  }
</style>
