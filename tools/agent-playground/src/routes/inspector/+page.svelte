<!--
  Inspector page — Job execution debugger ("Chrome DevTools for agent pipelines").

  Two modes driven by `inspector.sessionView !== null`:

  **No-session mode:** Full-size pipeline DAG + "Run Job" button + recent sessions.
  **Session mode:** Waterfall timeline (hero) + right sidebar with session metadata.
    Click a waterfall row to open the block detail panel below the waterfall.

  Toolbar is always visible: workspace/job selector + session info + Run button.

  @component
-->

<script lang="ts">
  import type { TopologyNode, WorkspaceConfig } from "@atlas/config";
  import { extractInitialStateIds, filterNoiseNodes } from "@atlas/config/pipeline-utils";
  import { deriveSignalDetails, type SignalDetail } from "@atlas/config/signal-details";
  import { deriveTopology } from "@atlas/config/topology";
  import type { AgentBlock } from "@atlas/core/session/session-events";
  import { Button, Dialog, DropdownMenu, IconSmall } from "@atlas/ui";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import AgentInspectionPanel from "$lib/components/inspector/agent-inspection-panel.svelte";
  import InspectorRecentSessions from "$lib/components/inspector/inspector-recent-sessions.svelte";
  import InspectorRunCard from "$lib/components/inspector/inspector-run-card.svelte";
  import InspectorSessionSidebar from "$lib/components/inspector/inspector-session-sidebar.svelte";
  import InspectorWorkspacePicker from "$lib/components/inspector/inspector-workspace-picker.svelte";
  import WaterfallTimeline from "$lib/components/inspector/waterfall-timeline.svelte";
  import SignalInputForm from "$lib/components/workspace/signal-input-form.svelte";
  import PipelineDiagram from "$lib/components/workspace/pipeline-diagram.svelte";
  import WorkspaceJobSelector from "$lib/components/workspace/workspace-job-selector.svelte";
  import { EXTERNAL_DAEMON_URL } from "$lib/daemon-url";
  import { createInspectorState } from "$lib/inspector-state.svelte";

  /** URL is the source of truth for workspace, job, session, and selected step. */
  const workspaceId = $derived(page.url.searchParams.get("workspace"));
  const jobId = $derived(page.url.searchParams.get("job"));
  const urlSessionId = $derived(page.url.searchParams.get("session"));
  const urlStep = $derived(page.url.searchParams.get("step"));

  /** Config comes from the selector's async fetch — not in URL. */
  let config = $state<WorkspaceConfig | null>(null);

  const inspector = createInspectorState();

  /** Whether we're in session-loaded mode (session header + waterfall + detail). */
  const hasSession = $derived(inspector.sessionView !== null);

  /** Selector callback — only takes config (workspace/job come from URL). */
  function handleSelection(selection: {
    workspaceId: string | null;
    jobId: string | null;
    config: WorkspaceConfig | null;
  }) {
    config = selection.config;
  }

  /**
   * Reset inspector when workspace/job changes.
   * Uses a composite key so we skip the initial mount (prevKey starts empty).
   */
  let prevKey = $state("");
  $effect(() => {
    const key = `${workspaceId}:${jobId}`;
    if (prevKey && key !== prevKey) {
      inspector.reset();
      if (page.url.searchParams.has("session") || page.url.searchParams.has("step")) {
        const url = new URL(page.url);
        url.searchParams.delete("session");
        url.searchParams.delete("step");
        goto(url.toString(), { replaceState: true });
      }
    }
    prevKey = key;
  });

  /** Fetch job config when workspace/job are known. */
  $effect(() => {
    if (workspaceId && jobId) {
      inspector.fetchJobConfig(jobId, workspaceId);
    }
  });

  /** Load session from URL param. */
  $effect(() => {
    if (urlSessionId && inspector.sessionId !== urlSessionId && !inspector.isExecuting) {
      inspector.loadSession(urlSessionId);
    }
  });

  /** Push session ID to URL after a live run completes. */
  let wasExecuting = $state(false);
  $effect(() => {
    const executing = inspector.isExecuting;
    if (wasExecuting && !executing) {
      const sid = inspector.sessionId;
      if (sid) {
        const url = new URL(page.url);
        url.searchParams.set("session", sid);
        url.searchParams.delete("step");
        goto(url.toString(), { replaceState: true });
      }
    }
    wasExecuting = executing;
  });

  /** Sync URL step param → inspector selected block. */
  $effect(() => {
    const step = urlStep;
    const blocks = inspector.sessionView?.agentBlocks ?? [];
    if (step) {
      const match = blocks.find((b) => b.stateId === step && b.status !== "pending");
      if (match && inspector.selectedBlock?.stateId !== step) {
        inspector.selectBlock(match);
      }
    } else if (inspector.selectedBlock) {
      inspector.selectBlock(null);
    }
  });

  /** Navigate to a step via URL (source of truth for selection). */
  function selectStep(block: AgentBlock | null) {
    const url = new URL(page.url);
    if (block?.stateId) {
      url.searchParams.set("step", block.stateId);
    } else {
      url.searchParams.delete("step");
    }
    goto(url.toString(), { replaceState: true });
  }

  /**
   * Build a workspace config scoped to the selected job + its signals.
   * deriveTopology processes all jobs, so we narrow the config first.
   */
  const jobConfig = $derived.by((): WorkspaceConfig | null => {
    if (!config || !jobId || !config.jobs) return null;
    const job = config.jobs[jobId];
    if (!job) return null;

    // Collect signal IDs referenced by the job's triggers
    const triggerSignals = new Set<string>();
    if ("triggers" in job && Array.isArray(job.triggers)) {
      for (const t of job.triggers) {
        if (typeof t === "object" && t !== null && "signal" in t && typeof t.signal === "string") {
          triggerSignals.add(t.signal);
        }
      }
    }

    // Filter signals to only those used by this job
    const signals: Record<string, NonNullable<WorkspaceConfig["signals"]>[string]> = {};
    if (config.signals) {
      for (const [id, signal] of Object.entries(config.signals)) {
        if (triggerSignals.has(id)) {
          signals[id] = signal;
        }
      }
    }

    return { ...config, jobs: { [jobId]: job }, signals };
  });

  const topology = $derived.by(() => {
    if (!jobConfig) return null;
    const raw = deriveTopology(jobConfig);
    const initialIds = extractInitialStateIds(jobConfig);
    return filterNoiseNodes(raw, initialIds);
  });

  /** Job spec metadata for the session header. */
  const jobSpec = $derived.by(() => {
    if (!config || !jobId || !config.jobs) return { title: jobId ?? undefined };
    const job = config.jobs[jobId];
    if (!job) return { title: jobId ?? undefined };
    return {
      title: "title" in job && typeof job.title === "string" ? job.title : (jobId ?? undefined),
      description:
        "description" in job && typeof job.description === "string" ? job.description : undefined,
    };
  });

  /** Derive selectedNodeId for PipelineDiagram from the selected block's stateId. */
  const selectedNodeId = $derived.by(() => {
    const stateId = inspector.selectedBlock?.stateId;
    if (!stateId || !jobId) return null;
    return `${jobId}:${stateId}`;
  });

  /** Map DAG node click to waterfall block selection. */
  function handleNodeClick(node: TopologyNode) {
    // Extract stateId from node ID format "${jobId}:${stateId}"
    const stateId = node.id.includes(":") ? node.id.split(":").slice(1).join(":") : node.label;
    const blocks = inspector.sessionView?.agentBlocks ?? [];
    const match = blocks.find((b) => b.stateId === stateId);
    if (match) {
      selectStep(match);
    }
  }

  /** Build node status map for DAG status overlays during live runs. */
  const nodeStatusMap = $derived.by((): Record<string, string> => {
    if (!jobId || !inspector.sessionView) return {};
    const result: Record<string, string> = {};
    for (const block of inspector.sessionView.agentBlocks) {
      if (block.stateId && block.status !== "pending") {
        result[`${jobId}:${block.stateId}`] = block.status;
      }
    }
    return result;
  });

  /** Signal details for the selected job's triggers (drives run dialog). */
  const jobSignals = $derived.by((): SignalDetail[] => {
    if (!jobConfig) return [];
    return deriveSignalDetails(jobConfig);
  });

  function handleRun(signalId: string, payload: Record<string, unknown>, skipStates: string[]) {
    if (!workspaceId) return;
    inspector.run(workspaceId, signalId, payload, skipStates);
  }

  function handleStop() {
    inspector.stop();
  }

  /** Navigate back to the job REPL (no-session view). */
  function handleNewRun() {
    inspector.reset();
    const url = new URL(page.url);
    url.searchParams.delete("session");
    url.searchParams.delete("step");
    goto(url.toString(), { replaceState: true });
  }

  // -- Rerun dialog state --

  let rerunPayload = $state<Record<string, unknown>>({});

  /** The first trigger signal for the current job. */
  const primarySignal = $derived(jobSignals[0] ?? null);

  /** Primary signal's schema narrowed to Record for SignalInputForm. */
  const primarySchema = $derived.by((): Record<string, unknown> | null => {
    const s = primarySignal?.schema;
    if (!s || typeof s !== "object") return null;
    return s as Record<string, unknown>;
  });

  /** Signal payload from the current session's first block input. */
  const sessionPayload = $derived.by((): Record<string, unknown> => {
    const blocks = inspector.sessionView?.agentBlocks;
    if (!blocks || blocks.length === 0) return {};
    return (blocks[0]?.input as Record<string, unknown>) ?? {};
  });

  /** Open the rerun dialog and pre-populate with current session's payload. */
  function openRerunDialog(dialogOpen: { set: (v: boolean) => void }) {
    rerunPayload = { ...sessionPayload };
    dialogOpen.set(true);
  }

  function handleRerunSubmit(dialogOpen: { set: (v: boolean) => void }) {
    if (!workspaceId || !primarySignal) return;
    dialogOpen.set(false);
    inspector.run(workspaceId, primarySignal.name, rerunPayload, [...inspector.disabledSteps]);
  }

  // -- Copy helpers --

  function copyCliCommand() {
    if (!workspaceId || !primarySignal) return;
    const body = JSON.stringify(sessionPayload);
    const escaped = body.replace(/'/g, "'\\''");
    const cmd = `docker compose exec platform atlas signal trigger ${primarySignal.name} --workspace ${workspaceId} --data '${escaped}'`;
    navigator.clipboard.writeText(cmd);
  }

  function copyCurlCommand() {
    if (!workspaceId || !primarySignal) return;
    const body = JSON.stringify(sessionPayload);
    const escaped = body.replace(/'/g, "'\\''");
    const curl = [
      "curl -X POST",
      `-H 'Content-Type: application/json'`,
      `-d '${escaped}'`,
      `${EXTERNAL_DAEMON_URL}/api/workspaces/${workspaceId}/signals/${primarySignal.name}`,
    ].join(" \\\n  ");
    navigator.clipboard.writeText(curl);
  }

  function handleSessionSelect(sessionId: string) {
    inspector.loadSession(sessionId);
    const url = new URL(page.url);
    url.searchParams.set("session", sessionId);
    url.searchParams.delete("step");
    goto(url.toString(), { replaceState: true });
  }

  function handleKeydown(e: KeyboardEvent) {
    // Skip when focus is in an input/textarea/contenteditable
    const target = e.target;
    if (target instanceof HTMLInputElement) return;
    if (target instanceof HTMLTextAreaElement) return;
    if (target instanceof HTMLSelectElement) return;
    if (target instanceof HTMLElement && target.isContentEditable) return;

    // Escape: close inspection panel
    if (e.key === "Escape" && inspector.selectedBlock) {
      e.preventDefault();
      selectStep(null);
      return;
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="inspector">
  <!-- Zone 1: Toolbar (hidden when picker is showing) -->
  {#if workspaceId && jobId}
    <div class="zone zone-toolbar">
      <div class="toolbar-start">
        <WorkspaceJobSelector onselection={handleSelection} />
      </div>
      <div class="toolbar-end">
        <InspectorRecentSessions {workspaceId} jobName={jobId} onselect={handleSessionSelect} />
        {#if hasSession}
          <Dialog.Root>
            {#snippet children(open)}
              <DropdownMenu.Root>
                <DropdownMenu.Trigger class="run-menu-trigger">
                  <span>Run…</span>
                  <IconSmall.CaretDown />
                </DropdownMenu.Trigger>
                <DropdownMenu.Content>
                  <DropdownMenu.Item onclick={handleNewRun}>New run</DropdownMenu.Item>
                  <DropdownMenu.Item onclick={() => openRerunDialog(open)}>Rerun</DropdownMenu.Item>
                  <DropdownMenu.Separator />
                  <DropdownMenu.Item onclick={copyCliCommand}>Copy CLI command</DropdownMenu.Item>
                  <DropdownMenu.Item onclick={copyCurlCommand}>Copy as curl</DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Root>

              <Dialog.Content size="large">
                <Dialog.Close />
                {#snippet header()}
                  <Dialog.Title>Rerun {jobSpec.title ?? "Job"}</Dialog.Title>
                {/snippet}
                {#snippet footer()}
                  <form
                    class="rerun-form"
                    onsubmit={(e) => {
                      e.preventDefault();
                      handleRerunSubmit(open);
                    }}
                  >
                    {#if primarySchema}
                      <SignalInputForm
                        schema={primarySchema}
                        values={rerunPayload}
                        onChange={(v) => { rerunPayload = v; }}
                      />
                    {/if}
                    <div class="rerun-actions">
                      <Dialog.Button type="submit" closeOnClick={false}>Run</Dialog.Button>
                      <Dialog.Cancel>Cancel</Dialog.Cancel>
                    </div>
                  </form>
                {/snippet}
              </Dialog.Content>
            {/snippet}
          </Dialog.Root>
        {/if}
      </div>
    </div>
  {/if}

  {#if !hasSession}
    <!-- No-session mode: hero DAG + Run button + recent sessions -->
    <div class="no-session">
      <div class="hero-dag">
        {#if topology}
          <PipelineDiagram
            {topology}
            {selectedNodeId}
            onNodeClick={handleNodeClick}
            {nodeStatusMap}
            disabledSteps={inspector.disabledSteps}
            onToggleStep={inspector.toggleStep}
          />
        {:else}
          <div class="zone-empty">
            <InspectorWorkspacePicker />
          </div>
        {/if}
      </div>

      {#if workspaceId && jobId && jobSignals.length > 0}
        <div class="run-card-wrapper">
          <InspectorRunCard
            signals={jobSignals}
            jobTitle={jobSpec.title}
            jobDescription={jobSpec.description}
            isExecuting={inspector.isExecuting}
            onrun={handleRun}
            onstop={handleStop}
            disabledSteps={inspector.disabledSteps}
            ontogglestep={inspector.toggleStep}
          />
        </div>
      {/if}

      {#if inspector.error}
        <div class="zone-empty">
          <span class="zone-label error-text">{inspector.error}</span>
        </div>
      {/if}
    </div>
  {:else}
    <!-- Session-loaded mode: waterfall (hero) + right sidebar -->
    <div class="session-layout">
      <div class="session-main">
        <div class="zone zone-waterfall">
          {#if inspector.error}
            <div class="zone-empty">
              <span class="zone-label error-text">{inspector.error}</span>
            </div>
          {:else}
            <WaterfallTimeline
              sessionView={inspector.sessionView}
              selectedBlock={inspector.selectedBlock}
              onselect={(block) => selectStep(block)}
            />
          {/if}
        </div>

        {#if inspector.selectedBlock}
          <div class="zone zone-inspection">
            <AgentInspectionPanel
              block={inspector.selectedBlock}
              resolvedStepAgent={inspector.resolvedStepAgent}
              {workspaceId}
              onclose={() => selectStep(null)}
            />
          </div>
        {/if}
      </div>

      {#if inspector.sessionView}
        <InspectorSessionSidebar sessionView={inspector.sessionView} {jobSpec} />
      {/if}
    </div>
  {/if}
</div>

<style>
  .inspector {
    display: flex;
    flex-direction: column;
    block-size: 100%;
    min-block-size: 0;
    background-image: radial-gradient(
      color-mix(in srgb, var(--color-text), transparent 94%) 1px,
      transparent 1px
    );
    background-size: 20px 20px;
  }

  .zone {
    display: flex;
    align-items: center;
    justify-content: center;
    border-block-end: 1px solid color-mix(in srgb, var(--color-text), transparent 85%);
  }

  .zone-label {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-1);
    font-family: var(--font-mono);
    user-select: none;
  }

  .zone-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    block-size: 100%;
    padding: var(--size-3);
  }

  .error-text {
    color: var(--color-error, #ef4444);
  }

  /* ---- Zone 1: Toolbar ---- */

  .zone-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    block-size: 48px;
    flex: 0 0 48px;
    padding-inline: var(--size-2);
    gap: var(--size-2);
    background: var(--color-surface-1);
  }

  .toolbar-start {
    flex: 1 1 0;
    min-inline-size: 0;
  }

  .toolbar-end {
    align-items: center;
    display: flex;
    flex: 0 0 auto;
    gap: var(--size-2);
  }

  :global(.run-menu-trigger) {
    align-items: center;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    color: var(--color-text);
    cursor: default;
    display: inline-flex;
    font-family: inherit;
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-6);
    gap: var(--size-2);
    padding: var(--size-1) var(--size-2);
  }

  .rerun-form {
    display: flex;
    flex-direction: column;
    gap: var(--size-4);
    inline-size: 100%;
    max-inline-size: var(--size-96);
  }

  .rerun-actions {
    align-items: center;
    display: flex;
    flex-direction: column;
    gap: var(--size-1-5);
    inline-size: 100%;
    padding-block-start: var(--size-1);
  }

  /* ---- No-session mode ---- */

  .no-session {
    flex: 1 1 0;
    display: flex;
    flex-direction: column;
    overflow: auto;
  }

  .hero-dag {
    flex: 1 1 0;
    display: flex;
    align-items: center;
    justify-content: center;
    min-block-size: 120px;
    overflow: auto;
  }

  .run-card-wrapper {
    flex: 0 0 auto;
    display: flex;
    justify-content: center;
    padding: var(--size-4) var(--size-6) var(--size-10);
  }

  /* ---- Session-loaded mode ---- */

  .session-layout {
    flex: 1 1 0;
    display: grid;
    grid-template-columns: 1fr 300px;
    min-block-size: 0;
    overflow: hidden;
  }

  .session-main {
    display: flex;
    flex-direction: column;
    min-block-size: 0;
    overflow: hidden;
  }

  .zone-waterfall {
    flex: 1 1 0;
    min-block-size: 120px;
    overflow: auto;
    border-block-end: none;
  }

  .zone-inspection {
    flex: 0 0 auto;
    align-items: stretch;
    justify-content: flex-start;
    min-block-size: 0;
    overflow: hidden;
    border-block-end: none;
  }

  /* ---- Reduced motion ---- */
</style>
