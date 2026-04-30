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
  import { Button, Dialog, DropdownMenu, IconLarge, Icons, toast } from "@atlas/ui";
  import { createQuery } from "@tanstack/svelte-query";
  import { goto } from "$app/navigation";
  import { browser } from "$app/environment";
  import { page } from "$app/state";
  import AgentsCard from "$lib/components/agents/agents-card.svelte";
  import SessionProgressCard from "$lib/components/session/session-progress-card.svelte";
  import CommunicatorsCard from "$lib/components/workspace/communicators-card.svelte";
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
  // Empty state — start-chat card
  // ---------------------------------------------------------------------------

  const isEmpty = $derived(
    !!configQuery.data &&
      jobSummaries.length === 0 &&
      signalsWithJobs.length === 0 &&
      workspaceAgents.length === 0 &&
      visibleSessions.length === 0,
  );

  let startMessage = $state("");
  let composerInputEl = $state<HTMLTextAreaElement | undefined>(undefined);

  $effect(() => {
    // Re-evaluate when the message changes.
    void startMessage;
    const el = composerInputEl;
    if (!el) return;
    el.style.height = "auto";
    const max = 240;
    const next = Math.min(el.scrollHeight, max);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  });

  const SUGGESTED_PROMPTS = [
    "Automate inbox triage",
    "Run daily research briefings",
    "Track leads and follow-ups",
    "Monitor systems for errors",
    "Fix bugs and ship PRs",
    "Build a searchable knowledge base",
  ];

  function startChat(msg = startMessage.trim()) {
    if (!msg || !workspaceId || !browser) return;
    sessionStorage.setItem(`chat-seed-${workspaceId}`, msg);
    void goto(`/platform/${workspaceId}/chat`);
  }

  function handleStartKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      startChat();
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

  // ---------------------------------------------------------------------------
  // Recent chats
  // ---------------------------------------------------------------------------

  interface ChatEntry {
    id: string;
    title?: string;
    source: "atlas" | "slack" | "discord" | "telegram" | "whatsapp";
    updatedAt: string;
  }

  let recentChats = $state<ChatEntry[]>([]);

  function formatRelativeTime(iso: string): string {
    const then = new Date(iso).getTime();
    const diffMs = Date.now() - then;
    const min = Math.floor(diffMs / 60_000);
    if (min < 1) return "just now";
    if (min < 60) return `${min}m`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h`;
    const day = Math.floor(hr / 24);
    if (day < 7) return `${day}d`;
    const wk = Math.floor(day / 7);
    if (wk < 4) return `${wk}w`;
    return `${Math.floor(day / 30)}mo`;
  }

  function chatSourceLabel(source: ChatEntry["source"]): string {
    switch (source) {
      case "atlas": return "Web";
      case "slack": return "Slack";
      case "discord": return "Discord";
      case "telegram": return "Telegram";
      case "whatsapp": return "WhatsApp";
      default: return source;
    }
  }

  $effect(() => {
    if (!workspaceId || !browser) return;
    const url = `/api/daemon/api/workspaces/${encodeURIComponent(workspaceId)}/chat?limit=5`;
    fetch(url)
      .then((res) => (res.ok ? (res.json() as Promise<{ chats: ChatEntry[] }>) : null))
      .then((data) => { if (data) recentChats = data.chats; })
      .catch(() => {});
  });

  // ---------------------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------------------

  type Tab = "activity" | "info";
  let activeTab = $state<Tab>("activity");
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

    <!-- Tabs (non-empty state only) -->
    {#if !isEmpty}
      <div class="tab-bar" role="tablist">
        <button
          class="tab"
          class:tab--active={activeTab === "activity"}
          role="tab"
          aria-selected={activeTab === "activity"}
          onclick={() => (activeTab = "activity")}
        >Activity</button>
        <button
          class="tab"
          class:tab--active={activeTab === "info"}
          role="tab"
          aria-selected={activeTab === "info"}
          onclick={() => (activeTab = "info")}
        >Info</button>
      </div>

      {#if activeTab === "activity"}
        <!-- Chat -->
        <div class="card">
          <header class="section-head">
            <h2 class="section-title">Chat</h2>
            {#if recentChats.length > 0}
              <span class="section-count">{recentChats.length}</span>
            {/if}
            <a href="/platform/{workspaceId}/chat" class="section-action">New chat</a>
          </header>
          {#if recentChats.length > 0}
            <div class="row-list">
              {#each recentChats as chat (chat.id)}
                <div class="list-row">
                  <a href="/platform/{workspaceId}/chat/{chat.id}" class="row-link">
                    <span class="row-name">{chat.title ?? "Untitled"}</span>
                  </a>
                  <span class="row-time">{formatRelativeTime(chat.updatedAt)}</span>
                  <span class="chat-source source-{chat.source}">{chatSourceLabel(chat.source)}</span>
                </div>
              {/each}
            </div>
          {:else}
            <p class="section-empty">No chats yet — <a href="/platform/{workspaceId}/chat">start a conversation</a>.</p>
          {/if}
        </div>

        <!-- Runs -->
        {#if topology && (latestSession ?? olderSessions.length > 0)}
          <div class="runs-card card">
            <header class="section-head">
              <h2 class="section-title">Recent Runs</h2>
              <span class="section-count">{visibleSessions.length}</span>
              <a href="/platform/{workspaceId}/sessions" class="section-action">View all</a>
            </header>

            {#if latestSession}
              <SessionProgressCard
                session={latestSession}
                {topology}
                {workspaceId}
                jobTitles={jobTitleMap}
              />
            {/if}
            {#if olderSessions.length > 0}
              <div class="row-list">
                {#each olderSessions as session (session.sessionId)}
                  <div class="list-row">
                    <a href="/platform/{workspaceId}/sessions/{session.sessionId}" class="row-link">
                      <span
                        class="status-dot"
                        class:dot-active={session.status === "active"}
                        class:dot-failed={session.status === "failed"}
                        class:dot-completed={session.status === "completed"}
                      ></span>
                      <span class="row-name">{jobTitleMap[session.jobName] ?? session.jobName}</span>
                    </a>
                    {#if session.durationMs}
                      <span class="row-mono">{formatDuration(session.durationMs)}</span>
                    {/if}
                    <span class="row-time">{formatTime(session.startedAt)}</span>
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        {/if}

      {:else}
        <!-- Info: Jobs + Signals + Agents -->
        {#if jobSummaries.length > 0 && workspaceId}
          <JobsIntegrationsCard {workspaceId} jobs={jobSummaries} signals={workspaceSignals} />
        {/if}
        {#if signalsWithJobs.length > 0 && workspaceId}
          <SignalsCard signals={signalsWithJobs} {workspaceId} {agentIds} />
        {/if}
        {#if workspaceId}
          <CommunicatorsCard {workspaceId} {config} />
        {/if}
        {#if workspaceAgents.length > 0 && workspaceId}
          <AgentsCard agents={workspaceAgents} {workspaceId} />
        {/if}
        {#if jobSummaries.length === 0 && signalsWithJobs.length === 0 && workspaceAgents.length === 0}
          <p class="info-empty">No jobs, signals, or agents configured yet — <a href="/platform/{workspaceId}/edit">edit the workspace config</a> to add them.</p>
        {/if}
      {/if}
    {/if}

    <!-- Empty state: no jobs/agents/signals/runs yet -->
    {#if isEmpty}
      <div class="empty-hero">
        <div class="hero-copy">
          <h2 class="hero-headline">AI that keeps working, even when you're not.</h2>
          <p class="hero-sub">
            Set up AI systems in minutes that don't drift, don't forget,
            and get the work done around the clock.
          </p>
        </div>

        <div class="composer-card">
          <textarea
            class="composer-input"
            placeholder="What do you need done?"
            bind:value={startMessage}
            bind:this={composerInputEl}
            onkeydown={handleStartKeydown}
            rows={3}
          ></textarea>

          <div class="composer-footer">
            <div class="suggested-prompts">
              {#each SUGGESTED_PROMPTS as prompt (prompt)}
                <button class="prompt-chip" onclick={() => startChat(prompt)}>
                  {prompt}
                </button>
              {/each}
            </div>
            <button
              class="composer-send"
              onclick={() => startChat()}
              disabled={!startMessage.trim()}
              aria-label="Send"
            >
              <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M8 13V3M8 3L3 8M8 3l5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>
          </div>
        </div>

        <div class="skeleton-cards">
          <a class="skeleton-card" href="/discover">
            <div class="skeleton-card-icon">
              <IconLarge.Compass />
            </div>
            <div class="skeleton-card-body">
              <div class="skeleton-card-title">Discover Spaces</div>
              <div class="skeleton-card-sub">Explore how others are using Friday, then build your own.</div>
              <div class="skeleton-lines">
                <div class="skeleton-line" style="inline-size: 90%"></div>
                <div class="skeleton-line" style="inline-size: 55%"></div>
              </div>
            </div>
          </a>

          <a
            class="skeleton-card"
            href="https://docs.hellofriday.ai"
            target="_blank"
            rel="noopener noreferrer"
          >
            <div class="skeleton-card-icon">
              <IconLarge.Write />
            </div>
            <div class="skeleton-card-body">
              <div class="skeleton-card-title">Docs</div>
              <div class="skeleton-card-sub">Learn more about Friday Studio.</div>
              <div class="skeleton-lines">
                <div class="skeleton-line" style="inline-size: 80%"></div>
                <div class="skeleton-line" style="inline-size: 60%"></div>
              </div>
            </div>
          </a>
        </div>
      </div>
    {/if}
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
    gap: var(--size-5);
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

  /* ── Tab bar ───────────────────────────────────────────────────────────── */

  .tab-bar {
    border-block-end: 1px solid var(--color-border-1);
    display: flex;
    gap: var(--size-1);
    margin-block-end: var(--size-1);
  }

  .tab {
    background: none;
    border: none;
    border-block-end: 2px solid transparent;
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    cursor: pointer;
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    margin-block-end: -1px;
    padding: var(--size-1-5) var(--size-3);
    transition:
      color 120ms ease,
      border-color 120ms ease;
  }

  .tab:hover:not(.tab--active) {
    color: color-mix(in srgb, var(--color-text), transparent 15%);
  }

  .tab--active {
    border-block-end-color: var(--color-text);
    color: var(--color-text);
  }

  .info-empty {
    color: color-mix(in srgb, var(--color-text), transparent 45%);
    font-size: var(--font-size-2);
    margin: 0;
    padding-block: var(--size-6);
    text-align: center;

    a {
      color: color-mix(in srgb, var(--color-text), transparent 20%);
    }

    a:hover {
      color: var(--color-text);
    }
  }

  /* ── Section card ──────────────────────────────────────────────────────── */

  .card {
    background: var(--color-surface-1);
    border-radius: var(--radius-4);
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
    padding: var(--size-4) var(--size-5);
  }

  /* ── Section header (MCP-style: h2 + count + action inline) ────────────── */

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
    font-size: var(--font-size-3);
    margin-inline-start: auto;
    text-decoration: none;
    transition: color 120ms ease;
    white-space: nowrap;
  }

  .section-action:hover {
    color: var(--color-text);
  }

  .section-empty {
    color: color-mix(in srgb, var(--color-text), transparent 45%);
    font-size: var(--font-size-3);
    margin: 0;
    padding-block: var(--size-2);

    a {
      color: color-mix(in srgb, var(--color-text), transparent 20%);
    }

    a:hover {
      color: var(--color-text);
    }
  }

  /* ── Generic row list (chat, compact runs) ──────────────────────────────── */

  .row-list {
    display: flex;
    flex-direction: column;
  }

  .list-row {
    align-items: center;
    border-block-end: 1px solid color-mix(in srgb, var(--color-border-1), transparent 50%);
    column-gap: var(--size-3);
    display: grid;
    grid-template-columns: 1fr auto auto;
    padding: var(--size-2-5) var(--size-3);
    position: relative;
    z-index: 1;
  }

  .list-row::before {
    background-color: var(--color-surface-2);
    content: "";
    inset: 0;
    opacity: 0;
    position: absolute;
    transition: opacity 150ms ease;
    z-index: -1;
  }

  .list-row:hover::before {
    opacity: 1;
  }

  .list-row:hover {
    border-color: transparent;
  }

  .list-row:has(+ .list-row:hover) {
    border-color: transparent;
  }

  /* Stretched link covers entire row; buttons/badges sit above it via z-index */
  .row-link {
    align-items: center;
    color: var(--color-text);
    display: flex;
    gap: var(--size-2-5);
    min-inline-size: 0;
    text-decoration: none;
  }

  .row-link::after {
    content: "";
    cursor: pointer;
    inset: 0;
    position: absolute;
    z-index: 0;
  }

  .row-name {
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-5);
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .row-mono {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    flex-shrink: 0;
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-2);
    position: relative;
    z-index: 1;
  }

  .row-time {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    flex-shrink: 0;
    font-size: var(--font-size-2);
    position: relative;
    z-index: 1;
  }

  /* Status dot for run rows */
  .status-dot {
    background-color: color-mix(in srgb, var(--color-text), transparent 60%);
    block-size: 7px;
    border-radius: 50%;
    flex-shrink: 0;
    inline-size: 7px;
  }

  .status-dot.dot-active {
    animation: pulse 1.6s ease-in-out infinite;
    background-color: var(--color-warning);
  }

  .status-dot.dot-failed {
    background-color: var(--color-error);
  }

  .status-dot.dot-completed {
    background-color: var(--color-success);
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.45; }
  }

  /* Chat source badge — sits above stretched link */
  .chat-source {
    border-radius: var(--radius-1);
    flex-shrink: 0;
    font-size: 10px;
    font-weight: var(--font-weight-6);
    letter-spacing: 0.03em;
    padding: 1px 5px;
    position: relative;
    text-transform: uppercase;
    z-index: 1;
  }

  .source-atlas {
    background-color: light-dark(hsl(220 60% 90%), hsl(220 30% 20%));
    color: light-dark(hsl(220 60% 35%), hsl(220 60% 75%));
  }

  .source-slack {
    background-color: light-dark(hsl(330 60% 90%), hsl(330 30% 20%));
    color: light-dark(hsl(330 60% 35%), hsl(330 60% 75%));
  }

  .source-discord {
    background-color: light-dark(hsl(240 60% 90%), hsl(240 30% 20%));
    color: light-dark(hsl(240 60% 35%), hsl(240 60% 75%));
  }

  .source-telegram {
    background-color: light-dark(hsl(200 70% 90%), hsl(200 30% 22%));
    color: light-dark(hsl(200 70% 35%), hsl(200 70% 75%));
  }

  .source-whatsapp {
    background-color: light-dark(hsl(142 60% 90%), hsl(142 30% 20%));
    color: light-dark(hsl(142 60% 30%), hsl(142 60% 70%));
  }

  /* Strip SessionProgressCard interior border/chrome when nested in runs card */
  .runs-card > :global(.progress-card) {
    border-block-end: 1px solid color-mix(in srgb, var(--color-border-1), transparent 50%);
    border-radius: 0;
    box-shadow: none;
    padding-inline: var(--size-3);
    position: relative;
    transition: border-color 250ms ease;
    z-index: 1;
  }

  .runs-card > :global(.progress-card)::before {
    background-color: var(--color-surface-2);
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

  /* Empty hero */
  .empty-hero {
    align-items: center;
    display: flex;
    flex-direction: column;
    gap: var(--size-8);
    padding-block: var(--size-10);
  }

  .hero-copy {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    max-inline-size: 580px;
    text-align: center;
    width: 100%;
  }

  .hero-headline {
    font-size: var(--font-size-7);
    font-weight: var(--font-weight-7);
    letter-spacing: -0.02em;
    line-height: var(--font-lineheight-1);
    margin: 0;
  }

  .hero-sub {
    color: color-mix(in srgb, var(--color-text), transparent 35%);
    font-size: var(--font-size-3);
    line-height: var(--font-lineheight-4);
    margin: 0 auto;
    max-inline-size: 44ch;
  }

  /* Composer card */
  .composer-card {
    background: var(--color-surface-1);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-4);
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
    max-inline-size: 580px;
    padding: var(--size-4) var(--size-5);
    width: 100%;
  }

  .composer-input {
    background: transparent;
    border: none;
    color: var(--color-text);
    font-family: inherit;
    font-size: var(--font-size-3);
    line-height: var(--font-lineheight-3);
    outline: none;
    padding: var(--size-1) var(--size-1);
    resize: none;
    width: 100%;

    &::placeholder {
      color: color-mix(in srgb, var(--color-text), transparent 55%);
    }
  }

  .composer-footer {
    align-items: center;
    display: flex;
    gap: var(--size-2);
    justify-content: space-between;
  }

  .composer-send {
    align-items: center;
    background: var(--color-accent, #1171df);
    border: none;
    border-radius: var(--radius-2);
    block-size: var(--size-7);
    color: white;
    cursor: pointer;
    display: flex;
    flex-shrink: 0;
    inline-size: var(--size-7);
    justify-content: center;
    transition: opacity 150ms ease;

    &:disabled {
      opacity: 0.3;
      cursor: default;
    }

    &:not(:disabled):hover {
      opacity: 0.85;
    }

    :global(svg) {
      block-size: 14px;
      inline-size: 14px;
    }
  }

  .suggested-prompts {
    display: flex;
    flex-wrap: wrap;
    gap: var(--size-1-5);
  }

  .prompt-chip {
    background: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-round);
    color: color-mix(in srgb, var(--color-text), transparent 20%);
    cursor: pointer;
    font-size: var(--font-size-1);
    padding: var(--size-1) var(--size-2-5);
    transition:
      background 120ms ease,
      border-color 120ms ease,
      color 120ms ease;

    &:hover {
      background: var(--color-surface-3);
      border-color: color-mix(in srgb, var(--color-accent, #1171df), transparent 55%);
      color: var(--color-text);
    }
  }

  /* Skeleton discovery cards */
  .skeleton-cards {
    display: grid;
    gap: var(--size-4);
    grid-template-columns: repeat(2, 1fr);
    max-inline-size: 580px;
    width: 100%;
  }

  .skeleton-card {
    background: var(--color-surface-1);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-3);
    color: inherit;
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
    opacity: 0.6;
    padding: var(--size-4) var(--size-4);
    text-decoration: none;
    transition:
      background-color 120ms ease,
      border-color 120ms ease,
      opacity 120ms ease;
  }

  a.skeleton-card:hover {
    background-color: var(--color-surface-2);
    border-color: color-mix(in srgb, var(--color-accent, #1171df), transparent 60%);
    opacity: 1;
  }

  .skeleton-card-icon {
    color: color-mix(in srgb, var(--color-text), transparent 40%);

    :global(svg) {
      block-size: 20px;
      inline-size: 20px;
    }
  }

  .skeleton-card-body {
    display: flex;
    flex-direction: column;
    gap: var(--size-1-5);
  }

  .skeleton-card-title {
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-6);
  }

  .skeleton-card-sub {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-size: var(--font-size-1);
    line-height: var(--font-lineheight-3);
  }

  .skeleton-lines {
    display: flex;
    flex-direction: column;
    gap: var(--size-1-5);
  }

  .skeleton-line {
    background: color-mix(in srgb, var(--color-text), transparent 82%);
    block-size: var(--size-2);
    border-radius: var(--radius-round);
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
