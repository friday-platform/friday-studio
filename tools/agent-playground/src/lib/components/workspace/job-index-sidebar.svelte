<!--
  Compact job index for the right sidebar on the jobs page.
  Each row shows the job title and a trigger type badge, linking to
  the corresponding job card via hash navigation.

  @component
  @param {JobEntry[]} jobs - Job entries with id, title, and trigger signal refs
  @param {SignalDetail[]} signalDetails - Signal details from deriveSignalDetails
-->

<script module lang="ts">
  /** Minimal job entry for sidebar display. */
  export interface JobEntry {
    id: string;
    title: string;
    triggers: { signal: string }[];
  }
</script>

<script lang="ts">
  import type { SignalDetail } from "@atlas/config/signal-details";
  import RecentSessions from "$lib/components/session/recent-sessions.svelte";
  import IntegrationsSidebar from "$lib/components/workspace/integrations-sidebar.svelte";

  type Props = { jobs: JobEntry[]; signalDetails: SignalDetail[]; workspaceId: string };

  let { jobs, signalDetails, workspaceId }: Props = $props();

</script>

{#if jobs.length > 0}
  <div class="job-index">
    <IntegrationsSidebar {workspaceId} />

    <RecentSessions {workspaceId} />
  </div>
{/if}

<style>
  .job-index {
    display: flex;
    flex-direction: column;
    gap: var(--size-8);
  }

  .jobs-section {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .section-header {
    align-items: baseline;
    display: flex;
    gap: var(--size-2);
  }

  .section-title {
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-5);
    margin: 0;
  }

  .section-badge {
    color: color-mix(in srgb, var(--color-text), transparent 60%);
    font-size: var(--font-size-0);
    font-variant-numeric: tabular-nums;
    margin-inline-start: auto;
  }

  .entries {
    display: flex;
    flex-direction: column;
  }

  .entry {
    align-items: center;
    color: inherit;
    display: flex;
    gap: var(--size-2);
    padding-block: var(--size-1-5);
    text-decoration: none;
  }

  .entry:not(:last-child) {
    border-block-end: 1px solid color-mix(in srgb, var(--color-border-1), transparent 50%);
  }

  .entry:hover {
    background-color: color-mix(in srgb, var(--color-surface-2), transparent 50%);
  }

  .job-name {
    color: var(--color-text);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

</style>
