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
  import { Button, Dialog, DropdownMenu, IconSmall, Icons, toast } from "@atlas/ui";
  import { createQuery } from "@tanstack/svelte-query";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import AgentsCard from "$lib/components/agents/agents-card.svelte";
  import SessionProgressCard from "$lib/components/session/session-progress-card.svelte";
  import JobsIntegrationsCard from "$lib/components/workspace/jobs-integrations-card.svelte";
  import SignalsCard from "$lib/components/workspace/signals-card.svelte";
  import { sessionQueries, useDeleteWorkspace, workspaceQueries } from "$lib/queries";
  import { writable } from "svelte/store";
  import { stringify } from "yaml";

  const workspaceId = $derived(page.params.workspaceId ?? null);
  const configQuery = createQuery(() => workspaceQueries.config(workspaceId));
  const config = $derived(configQuery.data?.config ?? null);

  // ---------------------------------------------------------------------------
  // Workspace color (shared cache with sidebar)
  // ---------------------------------------------------------------------------

  const workspacesQuery = createQuery(() => workspaceQueries.list());

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

  /** Jobs that are internal plumbing — hide from the overview. */
  const HIDDEN_JOBS = new Set(["handle-chat"]);

  const sessionsQuery = createQuery(() => ({
    ...sessionQueries.list(workspaceId),
    refetchInterval: 5_000,
  }));

  const visibleSessions = $derived(
    (sessionsQuery.data ?? []).filter((s) => !HIDDEN_JOBS.has(s.jobName)),
  );

  /** Latest session — rendered as full progress card. */
  const latestSession = $derived(visibleSessions[0] ?? null);

  /** Older sessions — compact rows (up to 3). */
  const olderSessions = $derived(visibleSessions.slice(1, 4));

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
  function exportWorkspaceConfig() {
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

  /**
   * Download the workspace as a portable zip bundle (workspace.yml + skills/ +
   * agents/, optionally including narrative memory in migration mode). The
   * daemon's route streams `application/zip`; we capture as a blob and trigger
   * a browser download with the server's Content-Disposition filename.
   */
  async function downloadWorkspaceBundle(mode: "definition" | "migration") {
    if (!workspaceId) return;
    const qs = mode === "migration" ? "?mode=migration" : "";
    const url = `/api/daemon/api/workspaces/${workspaceId}/bundle${qs}`;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        const errBody = await res.text();
        toast({
          title: `Download failed: ${errBody.slice(0, 200)}`,
          error: true,
        });
        return;
      }
      const blob = await res.blob();
      const disposition = res.headers.get("content-disposition") ?? "";
      const nameMatch = /filename="([^"]+)"/.exec(disposition);
      const filename = nameMatch?.[1] ?? `${workspaceId}.zip`;
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(href);
      toast({ title: "Workspace downloaded" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast({ title: `Download failed: ${msg}`, error: true });
    }
  }

  // ---------------------------------------------------------------------------
  // Delete workspace
  // ---------------------------------------------------------------------------

  const deleteMut = useDeleteWorkspace();
  const deleteDialogOpen = writable(false);

  async function confirmDelete() {
    if (!workspaceId || deleteMut.isPending) return;
    try {
      await deleteMut.mutateAsync(workspaceId);
      deleteDialogOpen.set(false);
      toast({ title: `${configQuery.data?.config?.workspace?.name ?? workspaceId} removed` });
      goto("/platform");
    } catch {
      toast({ title: "Failed to remove workspace", error: true });
    }
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
        <Button size="small" variant="secondary" href="/platform/{workspaceId}/edit">
          Edit Configuration
        </Button>
        <DropdownMenu.Root positioning={{ placement: "bottom-end" }}>
          {#snippet children()}
            <DropdownMenu.Trigger class="more-trigger" aria-label="More options">
              <Icons.TripleDots />
            </DropdownMenu.Trigger>

            <DropdownMenu.Content>
              <DropdownMenu.Item onclick={exportWorkspaceConfig}>
                Export configuration
              </DropdownMenu.Item>
              <DropdownMenu.Item onclick={() => downloadWorkspaceBundle("definition")}>
                Download workspace
              </DropdownMenu.Item>
              <DropdownMenu.Item onclick={() => downloadWorkspaceBundle("migration")}>
                Download workspace with notes &amp; memory
              </DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Item onclick={() => deleteDialogOpen.set(true)}>
                Remove workspace
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          {/snippet}
        </DropdownMenu.Root>
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

<Dialog.Root open={deleteDialogOpen}>
  {#snippet children()}
    <Dialog.Content>
      <Dialog.Close />

      {#snippet header()}
        <Dialog.Title>Remove workspace</Dialog.Title>
        <Dialog.Description>
          This will unregister <strong>{configQuery.data?.config?.workspace?.name ?? workspaceId}</strong> from Friday.
        </Dialog.Description>
      {/snippet}

      {#snippet footer()}
        <Dialog.Button onclick={confirmDelete} disabled={deleteMut.isPending} closeOnClick={false}>
          {deleteMut.isPending ? "Removing..." : "Remove"}
        </Dialog.Button>
        <Dialog.Cancel>Cancel</Dialog.Cancel>
      {/snippet}
    </Dialog.Content>
  {/snippet}
</Dialog.Root>

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
    gap: var(--size-2);
  }

  :global(.more-trigger) {
    align-items: center;
    background-color: var(--color-surface-2);
    block-size: var(--size-6);
    border: none;
    border-radius: var(--radius-2-5);
    color: var(--text-1);
    cursor: default;
    display: inline-flex;
    inline-size: var(--size-6);
    justify-content: center;
    transition: all 150ms ease;
    user-select: none;
    -webkit-user-select: none;
  }

  :global(.more-trigger:hover) {
    background-color: color-mix(in srgb, var(--color-surface-2), var(--color-text) 5%);
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
    color: color-mix(in srgb, var(--color-text), transparent 25%);
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
    color: color-mix(in srgb, var(--color-text), transparent 10%);
    font-size: var(--font-size-1);
    margin: 0;
  }

  .view-all-row {
    border-radius: var(--radius-2);
    color: color-mix(in srgb, var(--color-text), transparent 25%);
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
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    flex-shrink: 0;
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-1);
  }

  .compact-time {
    color: color-mix(in srgb, var(--color-text), transparent 25%);
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
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    font-size: var(--font-size-2) !important;
    font-weight: var(--font-weight-4) !important;
  }
</style>
