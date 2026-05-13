<!--
  Right sidebar wrapper for the jobs page. Shows integrations and recent
  sessions when the workspace has jobs.

  @component
  @param {JobEntry[]} jobs - Job entries used to decide whether to render sidebar content
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
  import RecentSessions from "$lib/components/session/recent-sessions.svelte";
  import IntegrationsSidebar from "$lib/components/workspace/integrations-sidebar.svelte";

  type Props = { jobs: JobEntry[]; workspaceId: string };

  let { jobs, workspaceId }: Props = $props();
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

</style>
