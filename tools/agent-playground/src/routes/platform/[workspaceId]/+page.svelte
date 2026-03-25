<!--
  Overview page — dashboard grid view of the workspace.

  Two-row grid: header (full width), sessions + jobs/integrations (2fr/1fr),
  signals + agents (1fr/1fr). Replaces the old vertical stack.

  @component
-->

<script lang="ts">
  import {
    extractInitialStateIds,
    filterNoiseNodes,
    humanizeStepName,
  } from "@atlas/config/pipeline-utils";
  import { deriveSignalDetails } from "@atlas/config/signal-details";
  import { deriveTopology } from "@atlas/config/topology";
  import { deriveWorkspaceAgents } from "@atlas/config/workspace-agents";
  import { IconSmall } from "@atlas/ui";
  import { createQuery } from "@tanstack/svelte-query";
  import { page } from "$app/state";
  import AgentsCard from "$lib/components/agents-card.svelte";
  import JobsIntegrationsCard from "$lib/components/jobs-integrations-card.svelte";
  import SessionProgressCard from "$lib/components/session-progress-card.svelte";
  import SignalsCard from "$lib/components/signals-card.svelte";
  import { getDaemonClient } from "$lib/daemon-client";
  import { useSessionsQuery } from "$lib/queries/sessions-query.svelte";
  import { useWorkspaceConfig } from "$lib/queries/workspace-config";
  import { stringify } from "yaml";

  const workspaceId = $derived(page.params.workspaceId ?? null);
  const configQuery = useWorkspaceConfig(() => workspaceId);
  const config = $derived(configQuery.data?.config ?? null);

  // ---------------------------------------------------------------------------
  // Workspace color (shared cache with sidebar)
  // ---------------------------------------------------------------------------

  const daemonClient = getDaemonClient();
  const workspacesQuery = createQuery(() => ({
    queryKey: ["workspaces"],
    queryFn: async () => {
      const res = await daemonClient.workspace.index.$get();
      if (!res.ok) throw new Error(`Failed to fetch workspaces: ${res.status}`);
      return res.json();
    },
  }));

  const COLORS: Record<string, string> = {
    yellow: "var(--yellow-2, #facc15)",
    purple: "var(--purple-2, #a78bfa)",
    red: "var(--red-2, #f87171)",
    blue: "var(--blue-2, #60a5fa)",
    green: "var(--green-2, #4ade80)",
    brown: "var(--brown-2, #a3824a)",
  };

  const workspaceColor = $derived.by(() => {
    const ws = (workspacesQuery.data ?? []).find((w) => w.id === workspaceId);
    const color = ws?.metadata?.color;
    return COLORS[color ?? "yellow"] ?? COLORS["yellow"];
  });

  // ---------------------------------------------------------------------------
  // Agents
  // ---------------------------------------------------------------------------

  const workspaceAgents = $derived.by(() => {
    if (!config) return [];
    return deriveWorkspaceAgents(config);
  });

  /** Agent IDs configured in the workspace (e.g. ["gh", "bb", "claude-code"]). */
  const agentIds = $derived.by(() => {
    const agents = config?.agents;
    if (!agents || typeof agents !== "object") return [];
    return Object.keys(agents);
  });

  // ---------------------------------------------------------------------------
  // Jobs
  // ---------------------------------------------------------------------------

  /** Derive job summaries for the jobs card. */
  const jobSummaries = $derived.by(
    (): {
      id: string;
      title: string;
      description: string | null;
      triggers: { signal: string }[];
    }[] => {
      if (!config?.jobs) return [];
      return Object.entries(config.jobs).map(([id, job]) => {
        const j = job as Record<string, unknown>;
        const title = typeof j?.title === "string" ? j.title : humanizeStepName(id);
        const description = typeof j?.description === "string" ? j.description : null;
        const triggers = Array.isArray(j?.triggers)
          ? j.triggers.filter(
              (t): t is { signal: string } => typeof t === "object" && t !== null && "signal" in t,
            )
          : [];
        return { id, title, description, triggers };
      });
    },
  );

  const workspaceSignals = $derived.by(
    (): Record<
      string,
      { description: string; title?: string; schema?: Record<string, unknown> }
    > => {
      if (!config?.signals) return {};
      const result: Record<
        string,
        { description: string; title?: string; schema?: Record<string, unknown> }
      > = {};
      for (const [id, sig] of Object.entries(config.signals)) {
        result[id] = { description: sig.description, title: sig.title, schema: sig.schema };
      }
      return result;
    },
  );

  // ---------------------------------------------------------------------------
  // Signals
  // ---------------------------------------------------------------------------

  const signalDetails = $derived.by(() => {
    if (!config) return [];
    return deriveSignalDetails(config);
  });

  /** Map signal details to the shape expected by SignalsCard. */
  const signalsWithJobs = $derived.by(() => {
    const titles: Record<string, string> = {};
    for (const job of jobSummaries) {
      titles[job.id] = job.title;
    }
    return signalDetails.map((s) => ({
      id: s.name,
      name: s.name,
      type: s.provider,
      description: s.title ?? s.name,
      linkedJobs: s.triggeredJobs.map((id) => titles[id] ?? humanizeStepName(id)),
      endpoint: s.endpoint,
      schedule: s.schedule,
      timezone: s.timezone,
      watchPath: s.watchPath,
    }));
  });

  // ---------------------------------------------------------------------------
  // Sessions / Runs
  // ---------------------------------------------------------------------------

  /** Topology for session progress cards. */
  const topology = $derived.by(() => {
    if (!config) return null;
    const raw = deriveTopology(config);
    const initialIds = extractInitialStateIds(config);
    return filterNoiseNodes(raw, initialIds);
  });

  const sessionsQuery = useSessionsQuery(() => workspaceId);

  /** Latest session — rendered as full progress card. */
  const latestSession = $derived((sessionsQuery.data ?? [])[0] ?? null);

  /** Older sessions — compact rows (up to 3). */
  const olderSessions = $derived.by(() => {
    const data = sessionsQuery.data ?? [];
    return data.slice(1, 4);
  });

  /** Map job ID → human-readable title for display in session rows. */
  const jobTitleMap = $derived.by((): Record<string, string> => {
    const result: Record<string, string> = {};
    for (const job of jobSummaries) {
      result[job.id] = job.title;
    }
    return result;
  });

  /** Format duration in ms to human-readable. */
  function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
  }

  function formatTime(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }

  /** Download the workspace config as a YAML file. */
  function exportWorkspace() {
    if (!configQuery.data) return;
    const yamlStr = stringify(configQuery.data.config);
    const blob = new Blob([yamlStr], { type: "text/yaml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "workspace.yml";
    a.click();
    URL.revokeObjectURL(url);
  }
</script>

<div class="overview-page">
  {#if !workspaceId}
    <div class="empty-state">
      <p>No workspace selected</p>
      <p class="hint">Select a workspace from the sidebar</p>
    </div>
  {:else if configQuery.isLoading}
    <div class="empty-state">
      <p class="hint">Loading workspace...</p>
    </div>
  {:else if configQuery.isError}
    <div class="empty-state">
      <p>Failed to load workspace config</p>
      <p class="hint">{configQuery.error?.message}</p>
    </div>
  {:else if configQuery.data}
    <!-- Row 1: Header -->
    <div class="workspace-header">
      <div class="header-info">
        <h1 class="workspace-name">
          <span class="workspace-dot" style:color={workspaceColor}><span></span></span>
          {configQuery.data.config.workspace.name}
        </h1>
        {#if configQuery.data.config.workspace.description}
          <p class="workspace-description">{configQuery.data.config.workspace.description}</p>
        {/if}
      </div>
      <div class="actions">
        <a href="/platform/{workspaceId}/edit">
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d="M8.70996 1.5C9.19196 1.5 9.60385 1.84421 9.69238 2.31641L9.88867 3.37109C9.90368 3.37718 9.91864 3.38341 9.93359 3.38965L10.8223 2.7832L10.8984 2.73633C11.2851 2.51959 11.7746 2.58287 12.0938 2.90137L13.0986 3.90625L13.1592 3.97266C13.4435 4.31328 13.471 4.80591 13.2168 5.17773H13.2158L12.6084 6.0625C12.6148 6.07774 12.6207 6.09311 12.627 6.1084L13.6846 6.30762H13.6836C14.1558 6.39615 14.5 6.80804 14.5 7.29004V8.70996C14.5 9.19196 14.1558 9.60385 13.6836 9.69238L12.627 9.88965C12.6209 9.90466 12.6146 9.9196 12.6084 9.93457L13.2168 10.8223C13.471 11.1941 13.4435 11.6867 13.1592 12.0273L13.0986 12.0938L12.0938 13.0986C11.7533 13.4384 11.2189 13.488 10.8223 13.2168V13.2158L9.93457 12.6084C9.9196 12.6146 9.90466 12.6209 9.88965 12.627L9.69238 13.6836C9.60385 14.1558 9.19196 14.5 8.70996 14.5H7.29004C6.80826 14.5 6.39641 14.1564 6.30762 13.6846L6.1084 12.627C6.09311 12.6207 6.07774 12.6148 6.0625 12.6084L5.17773 13.2158V13.2168C4.80591 13.471 4.31328 13.4435 3.97266 13.1592L3.90625 13.0986L2.90137 12.0938C2.56161 11.7533 2.51205 11.2189 2.7832 10.8223L3.38965 9.93359C3.38341 9.91864 3.37718 9.90368 3.37109 9.88867L2.31641 9.69238C1.84421 9.60385 1.5 9.19196 1.5 8.70996V7.29004C1.5 6.80826 1.84356 6.39641 2.31543 6.30762L3.37109 6.10742C3.37705 6.09281 3.38258 6.07802 3.38867 6.06348L2.7832 5.17773C2.51205 4.78114 2.56165 4.24668 2.90137 3.90625L3.90625 2.90137L3.97266 2.84082C4.31329 2.55646 4.80593 2.52899 5.17773 2.7832L6.06348 3.38867C6.07802 3.38258 6.09281 3.37705 6.10742 3.37109L6.30762 2.31543C6.39641 1.84356 6.80826 1.5 7.29004 1.5H8.70996ZM7.29004 2.50098L7.03809 3.83301L6.98438 4.11914L6.70801 4.21387C6.54459 4.26962 6.38615 4.3344 6.23438 4.40918L5.97266 4.53906L5.73145 4.37402L4.61328 3.60938V3.6084L3.6084 4.61328H3.60938L4.37402 5.73145L4.53906 5.97266L4.40918 6.23438C4.3344 6.38615 4.26962 6.54459 4.21387 6.70801L4.11914 6.98438L3.83301 7.03809L2.50098 7.29004H2.5V8.70996L3.83203 8.95898L4.11914 9.0127L4.21387 9.28906C4.27001 9.45402 4.33452 9.61305 4.40918 9.76465L4.53809 10.0264L4.37402 10.2676L3.60938 11.3867H3.6084L4.61328 12.3916V12.3906L5.73047 11.626L5.97168 11.46L6.2334 11.5898C6.38448 11.6643 6.54365 11.7288 6.70898 11.7852L6.98535 11.8799L7.03906 12.166L7.29004 13.499V13.5H8.70996L8.95898 12.167L9.0127 11.8799L9.28906 11.7852C9.4551 11.7286 9.6145 11.6643 9.76562 11.5898L10.0273 11.46L10.2686 11.626L11.3857 12.3906H11.3867V12.3916L12.3916 11.3867H12.3906L11.626 10.2686L11.46 10.0273L11.5898 9.76562C11.6643 9.6145 11.7286 9.4551 11.7852 9.28906L11.8799 9.0127L12.167 8.95898L13.5 8.70996V7.29004H13.499L12.166 7.03906L11.8799 6.98535L11.7852 6.70898C11.7288 6.54365 11.6643 6.38448 11.5898 6.2334L11.46 5.97168L11.626 5.73047L12.3906 4.61328H12.3916L11.3867 3.6084V3.60938L10.2676 4.37402L10.0264 4.53809L9.76465 4.40918C9.61305 4.33452 9.45402 4.27001 9.28906 4.21387L9.0127 4.11914L8.95898 3.83203L8.70996 2.5H7.29004V2.50098ZM8 5.25C9.51878 5.25 10.75 6.48122 10.75 8C10.75 9.51878 9.51878 10.75 8 10.75C6.48122 10.75 5.25 9.51878 5.25 8C5.25 6.48122 6.48122 5.25 8 5.25ZM8 6.25C7.0335 6.25 6.25 7.0335 6.25 8C6.25 8.9665 7.0335 9.75 8 9.75C8.9665 9.75 9.75 8.9665 9.75 8C9.75 7.0335 8.9665 6.25 8 6.25Z"
              fill="currentColor"
            />
          </svg>
          Edit configuration
        </a>
        <button onclick={exportWorkspace}>
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d="M2.5 6.49984C2.50009 6.22377 2.72391 5.99984 3 5.99984C3.27609 5.99984 3.49991 6.22377 3.5 6.49984L3.5 11.4998C3.5 12.3283 4.17157 12.9998 5 12.9998L11 12.9998C11.8284 12.9998 12.5 12.3283 12.5 11.4998L12.5 6.49984C12.5001 6.22377 12.7239 5.99984 13 5.99984C13.2761 5.99984 13.4999 6.22377 13.5 6.49984L13.5 11.4998C13.5 12.8806 12.3807 13.9998 11 13.9998L5 13.9998C3.61929 13.9998 2.5 12.8806 2.5 11.4998L2.5 6.49984ZM5.14648 5.35336C4.9513 5.15809 4.95125 4.84156 5.14648 4.64632L8 1.79281L10.8535 4.64632C11.0488 4.84156 11.0487 5.15809 10.8535 5.35336C10.6583 5.54862 10.3417 5.54862 10.1465 5.35336L8.5 3.70687L8.5 9.49984C8.5 9.77598 8.27614 9.99984 8 9.99984C7.72386 9.99984 7.5 9.77598 7.5 9.49984L7.5 3.70687L5.85352 5.35336C5.65825 5.54862 5.34175 5.54862 5.14648 5.35336Z"
              fill="currentColor"
            />
          </svg>
          Export
        </button>
      </div>
    </div>

    <!-- Row 2: Sessions + Jobs/Integrations -->
    <div class="row-2">
      {#if topology && (latestSession ?? olderSessions.length > 0)}
        <div class="runs-card card">
          <div class="card-header">
            <h2 class="card-title">Recent Runs</h2>
            <p class="card-lede">Each run traces a signal through your pipeline.</p>
          </div>

          {#if latestSession}
            <SessionProgressCard
              session={latestSession}
              {topology}
              {workspaceId}
              jobTitles={jobTitleMap}
            />
          {/if}
          {#if olderSessions.length > 0}
            <div class="compact-runs">
              {#each olderSessions as session (session.sessionId)}
                <a href="/platform/{workspaceId}/sessions/{session.sessionId}" class="compact-run">
                  <span class="compact-job">{jobTitleMap[session.jobName] ?? session.jobName}</span>
                  <span
                    class="status-icon"
                    class:status-active={session.status === "active"}
                    class:status-failed={session.status === "failed"}
                    class:status-completed={session.status === "completed"}
                  >
                    {#if session.status === "completed"}
                      <IconSmall.Check />
                    {:else if session.status === "failed"}
                      <IconSmall.Close />
                    {:else if session.status === "active"}
                      <span class="spin"><IconSmall.Progress /></span>
                    {/if}
                  </span>
                  {#if session.durationMs}
                    <span class="compact-duration">{formatDuration(session.durationMs)}</span>
                  {/if}
                  <span class="compact-time">{formatTime(session.startedAt)}</span>
                </a>
              {/each}
            </div>
          {/if}
          <a href="/platform/{workspaceId}/sessions" class="view-all-row">View all runs</a>
        </div>
      {/if}

      {#if jobSummaries.length > 0 && workspaceId}
        <JobsIntegrationsCard {workspaceId} jobs={jobSummaries} signals={workspaceSignals} />
      {/if}
    </div>

    <!-- Row 3: Signals + Agents -->
    <div class="row-3">
      {#if signalsWithJobs.length > 0 && workspaceId}
        <SignalsCard signals={signalsWithJobs} {workspaceId} {agentIds} />
      {/if}

      {#if workspaceAgents.length > 0 && workspaceId}
        <AgentsCard agents={workspaceAgents} {workspaceId} />
      {/if}
    </div>
  {/if}
</div>

<style>
  .overview-page {
    display: flex;
    flex-direction: column;
    gap: var(--size-6);
    padding: var(--size-8) var(--size-10);
  }

  .workspace-header {
    align-items: flex-start;
    display: flex;
    gap: var(--size-4);
    justify-content: space-between;
  }

  .header-info {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .actions {
    align-items: center;
    display: flex;
    gap: var(--size-3);
  }

  .actions :global(svg) {
    opacity: 0.5;
  }

  .actions a,
  .actions button {
    align-items: center;
    background: none;
    border: none;
    color: color-mix(in srgb, var(--color-text), transparent 20%);
    cursor: pointer;
    display: flex;
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    gap: var(--size-1-5);
  }

  .workspace-name {
    align-items: center;
    color: var(--color-text);
    display: flex;
    font-size: var(--font-size-8);
    font-weight: var(--font-weight-7);
    gap: var(--size-3);
    line-height: var(--font-lineheight-1);
    margin: 0;
  }

  .workspace-dot {
    align-items: center;
    aspect-ratio: 1;
    block-size: var(--size-4);
    display: flex;
    justify-content: center;

    span {
      background-color: currentColor;
      block-size: 11px;
      border: var(--size-0-5) solid var(--color-white);
      border-radius: var(--radius-round);
      box-shadow: var(--shadow-1);
      inline-size: 11px;
    }
  }

  .workspace-description {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-3);
    line-height: var(--font-lineheight-3);
    margin: 0;
    max-inline-size: 56ch;
  }

  /* Row 2: Sessions (2/3) + Jobs/Integrations (1/3) */
  .row-2 {
    display: grid;
    gap: var(--size-6);
    grid-template-columns: 2fr 1fr;
  }

  /* Row 3: Signals + Agents (equal) */
  .row-3 {
    display: grid;
    gap: var(--size-6);
    grid-template-columns: repeat(2, 1fr);
  }

  @media (max-width: 900px) {
    .row-2 {
      grid-template-columns: 1fr;
    }

    .row-3 {
      grid-template-columns: 1fr;
    }
  }

  .card {
    background: var(--color-surface-1);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-3);
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
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

  .view-all-row {
    border-radius: var(--radius-2);
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-1);
    padding: var(--size-2) var(--size-1);
    text-align: center;
    transition:
      background 150ms ease,
      color 150ms ease;
  }

  .view-all-row:hover {
    background: var(--color-surface-2);
    color: var(--color-text);
  }

  /* Strip interior border from SessionProgressCard inside runs card */
  .runs-card > :global(.progress-card) {
    border-block-end: 1px solid color-mix(in srgb, var(--color-border-1), transparent 50%);
    border-radius: 0;
    box-shadow: none;
    padding-inline: var(--size-1);
    position: relative;
    transition: border-color 250ms ease;
    z-index: 1;
  }

  .runs-card > :global(.progress-card)::before {
    background-color: var(--color-surface-2);
    border-radius: var(--radius-4);
    content: "";
    inset: 0;
    opacity: 0;
    position: absolute;
    transition: opacity 150ms ease;
    z-index: -1;
  }

  .runs-card > :global(.progress-card:hover) {
    border-color: transparent;
  }

  .runs-card > :global(.progress-card:hover)::before {
    opacity: 1;
  }

  /* Compact run rows */
  .compact-runs {
    display: flex;
    flex-direction: column;
  }

  .compact-run {
    align-items: center;
    border-block-end: 1px solid color-mix(in srgb, var(--color-border-1), transparent 50%);
    color: var(--color-text);
    display: flex;
    font-size: var(--font-size-2);
    gap: var(--size-2);
    padding: var(--size-3) var(--size-1);
    position: relative;
    transition: border-color 250ms ease;
    z-index: 1;
  }

  .compact-run:last-child {
    border-block-end: 1px solid color-mix(in srgb, var(--color-border-1), transparent 50%);
  }

  .compact-run::before {
    background-color: var(--color-surface-2);
    border-radius: var(--radius-4);
    content: "";
    inset: 0;
    opacity: 0;
    position: absolute;
    transition: opacity 150ms ease;
    z-index: -1;
  }

  .compact-run:hover {
    border-color: transparent;
  }

  .compact-run:hover::before {
    opacity: 1;
  }

  .compact-run:has(+ .compact-run:hover) {
    border-color: transparent;
  }

  .status-icon {
    align-items: center;
    color: color-mix(in srgb, var(--color-text), transparent 60%);
    display: flex;
    flex-shrink: 0;
  }

  .status-icon.status-active {
    color: var(--color-warning);
  }

  .status-icon.status-failed {
    color: var(--color-error);
  }

  .status-icon.status-completed {
    color: var(--color-success);
  }

  .spin {
    animation: spin 2s linear infinite;
    display: flex;
  }

  @keyframes spin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }

  .compact-job {
    font-weight: var(--font-weight-5);
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .compact-duration {
    margin-inline-start: auto;
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    flex-shrink: 0;
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-1);
  }

  .compact-time {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    flex-shrink: 0;
    font-size: var(--font-size-1);
  }

  /* When no duration exists, push time right instead */
  .status-icon + .compact-time {
    margin-inline-start: auto;
  }

  /* Empty / loading states */
  .empty-state {
    align-items: center;
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--size-2);
    justify-content: center;
    padding: var(--size-10);
  }

  .empty-state p {
    font-size: var(--font-size-4);
    font-weight: var(--font-weight-5);
  }

  .hint {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-2) !important;
    font-weight: var(--font-weight-4) !important;
  }
</style>
