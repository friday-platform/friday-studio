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
  import InlineBadge from "$lib/components/shared/inline-badge.svelte";
  import RecentSessions from "$lib/components/session/recent-sessions.svelte";

  type Props = { jobs: JobEntry[]; signalDetails: SignalDetail[]; workspaceId: string };

  let { jobs, signalDetails, workspaceId }: Props = $props();

  /**
   * Resolve the primary trigger type label for a job.
   * Uses the first trigger's signal to look up the provider from signal details.
   */
  function triggerBadge(job: JobEntry): string | null {
    if (job.triggers.length === 0) return null;
    const signalName = job.triggers[0].signal;
    const detail = signalDetails.find((s) => s.name === signalName);
    if (!detail) return null;
    return detail.provider.toUpperCase();
  }

  function triggerVariant(job: JobEntry): "info" | "warning" | "accent" {
    const signalName = job.triggers[0]?.signal;
    const detail = signalDetails.find((s) => s.name === signalName);
    if (detail?.provider === "http") return "info";
    if (detail?.provider === "schedule") return "warning";
    return "accent";
  }
</script>

{#if jobs.length > 0}
  <div class="job-index">
    <section class="explainer">
      <h3 class="section-title">How jobs work</h3>
      <p class="explainer-text">
        Jobs are autonomous workflows triggered by signals — an HTTP request, a cron schedule, or a
        file change. Each job runs a pipeline of agents to completion.
      </p>
      <a class="learn-more" href="https://fridayagent.ai/docs/jobs">Learn more →</a>
    </section>

    <div class="section-header">
      <h3 class="section-title">Jobs</h3>
      <span class="section-badge">{jobs.length}</span>
    </div>
    <div class="entries">
      {#each jobs as job (job.id)}
        {@const badge = triggerBadge(job)}
        <a class="entry" href="#job-{job.id}">
          <span class="job-name">{job.title}</span>
          {#if badge}
            <InlineBadge variant={triggerVariant(job)}>{badge}</InlineBadge>
          {/if}
        </a>
      {/each}
    </div>

    <RecentSessions {workspaceId} />
  </div>
{/if}

<style>
  .job-index {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    padding-block-start: var(--size-10);
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

  .explainer {
    border-block-end: 1px solid color-mix(in srgb, var(--color-border-1), transparent 50%);
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
    padding-block-end: var(--size-3);
  }

  .explainer-text {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-size: var(--font-size-1);
    line-height: 1.5;
    margin: 0;
  }

  .learn-more {
    color: var(--color-info);
    font-size: var(--font-size-1);
    text-decoration: none;
  }

  .learn-more:hover {
    text-decoration: underline;
  }


</style>
