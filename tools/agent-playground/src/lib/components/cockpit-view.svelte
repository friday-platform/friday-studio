<!--
  Main cockpit view showing the workspace pipeline diagram.
  Rendered on all cockpit routes (base, signal, agent).

  Derives selected node ID from route params so the diagram highlights
  the active node. Run controls and recent sessions live in the right sidebar.

  @component
-->

<script lang="ts">
  import { deriveAgentJobUsage, type AgentStepRef } from "@atlas/config/agent-job-usage";
  import { deriveDataContracts } from "@atlas/config/data-contracts";
  import { deriveAllEntryActions, type EntryAction } from "@atlas/config/entry-actions";
  import { mapSessionToStepStatus, type StepStatus } from "@atlas/config/map-session-status";
  import { extractInitialStateIds, filterNoiseNodes, humanizeStepName } from "@atlas/config/pipeline-utils";
  import { deriveSignalDetails } from "@atlas/config/signal-details";
  import { deriveWorkspaceAgents } from "@atlas/config/workspace-agents";
  import { deriveTopology } from "@atlas/config/topology";
  import type { SessionSummary } from "@atlas/core/session/session-events";
  import { createQuery } from "@tanstack/svelte-query";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import AgentsStrip from "$lib/components/agents-strip.svelte";
  import DataContractsPanel from "$lib/components/data-contracts-panel.svelte";
  import JobSelector, { type JobInfo } from "$lib/components/job-selector.svelte";
  import PipelineDiagram from "$lib/components/pipeline-diagram.svelte";
  import RunJobDialog from "$lib/components/run-job-dialog.svelte";
  import SignalsPanel from "$lib/components/signals-panel.svelte";
  import { clearSelection, selectNode } from "$lib/node-selection.svelte";
  import { useSessionsQuery } from "$lib/queries/sessions-query.svelte";
  import { useWorkspaceConfig } from "$lib/queries/workspace-config";
  import { fetchSessionView } from "$lib/utils/session-event-stream";

  const workspaceId = $derived(page.params.workspaceId ?? null);

  /** Derive selected node ID from URL params. */
  const selectedNodeId = $derived.by(() => {
    if (page.params.signalId) return `signal:${page.params.signalId}`;
    if (page.params.nodeId) return page.params.nodeId;
    return null;
  });

  const configQuery = useWorkspaceConfig(() => workspaceId);

  const topology = $derived.by(() => {
    const data = configQuery.data;
    if (!data) return null;
    const raw = deriveTopology(data.config);
    const initialIds = extractInitialStateIds(data.config);
    return filterNoiseNodes(raw, initialIds);
  });

  const entryActionsMap = $derived.by(() => {
    const data = configQuery.data;
    if (!data) return null;
    return deriveAllEntryActions(data.config);
  });

  const workspaceAgents = $derived.by(() => {
    const data = configQuery.data;
    if (!data) return [];
    return deriveWorkspaceAgents(data.config);
  });

  /** Currently selected workspace agent ID from route params. */
  const selectedAgentId = $derived(page.params.agentId ?? null);

  /** Navigate to workspace agent detail route. Toggles off if already selected. */
  function selectWorkspaceAgent(agentId: string) {
    if (!workspaceId) return;
    const basePath = `/platform/${workspaceId}`;
    if (selectedAgentId === agentId) {
      goto(basePath);
    } else {
      goto(`${basePath}/workspace-agent/${agentId}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Multi-job: job selector + scoping
  // ---------------------------------------------------------------------------

  /** Derive job metadata from topology nodes + config titles. */
  const jobInfos = $derived.by((): JobInfo[] => {
    const data = configQuery.data;
    if (!data || !topology) return [];

    const jobs = data.config.jobs;
    if (!jobs) return [];

    const jobIds = Object.keys(jobs);
    if (jobIds.length < 2) return [];

    return jobIds
      .filter((id) => topology.nodes.some((n) => n.jobId === id))
      .map((id) => {
        const job = jobs[id] as Record<string, unknown>;
        const title = typeof job?.title === "string" ? job.title : humanizeStepName(id);
        const stepCount = topology.nodes.filter(
          (n) => n.jobId === id && n.type === "agent-step",
        ).length;
        return { id, title, stepCount };
      });
  });

  const isMultiJob = $derived(jobInfos.length > 1);

  /** Selected job ID — auto-selects first job when config changes. */
  let selectedJobId = $state<string | null>(null);

  $effect(() => {
    if (isMultiJob && (!selectedJobId || !jobInfos.some((j) => j.id === selectedJobId))) {
      selectedJobId = jobInfos[0].id;
    }
    if (!isMultiJob) {
      selectedJobId = null;
    }
  });

  /** Topology scoped to selected job (or full topology for single-job). */
  const scopedTopology = $derived.by(() => {
    if (!topology) return null;
    if (!selectedJobId) return topology;
    return {
      ...topology,
      nodes: topology.nodes.filter((n) => !n.jobId || n.jobId === selectedJobId),
      edges: topology.edges.filter((e) => {
        const from = topology.nodes.find((n) => n.id === e.from);
        const to = topology.nodes.find((n) => n.id === e.to);
        return (!from?.jobId || from.jobId === selectedJobId) &&
               (!to?.jobId || to.jobId === selectedJobId);
      }),
    };
  });

  /** Data contracts scoped to selected job (or all for single-job). */
  const scopedDataContracts = $derived.by(() => {
    if (!selectedJobId) return dataContracts;
    return dataContracts.filter((c) => c.jobId === selectedJobId);
  });

  /** Entry actions scoped to selected job (or all for single-job). */
  const scopedEntryActionsMap = $derived.by(() => {
    if (!entryActionsMap) return null;
    if (!selectedJobId) return entryActionsMap;
    const prefix = `${selectedJobId}:`;
    const scoped = new Map<string, EntryAction[]>();
    for (const [key, value] of entryActionsMap) {
      if (key.startsWith(prefix)) {
        scoped.set(key, value);
      }
    }
    return scoped;
  });

  /** Agent-to-job usage map for dimming agents strip in multi-job mode. */
  const agentJobUsage = $derived.by(() => {
    const data = configQuery.data;
    if (!data) return new Map<string, AgentStepRef[]>();
    return deriveAgentJobUsage(data.config);
  });

  /** Agent IDs not used by the selected job — dimmed in the strip. */
  const dimmedAgentIds = $derived.by((): Set<string> | undefined => {
    if (!selectedJobId) return undefined;
    const dimmed = new Set<string>();
    for (const [agentId, refs] of agentJobUsage) {
      const usedInSelectedJob = refs.some((r) => r.jobId === selectedJobId);
      if (!usedInSelectedJob) dimmed.add(agentId);
    }
    return dimmed.size > 0 ? dimmed : undefined;
  });

  // ---------------------------------------------------------------------------
  // JOBS section header — title, description, step counter
  // ---------------------------------------------------------------------------

  /** Current job metadata for the JOBS section header. */
  const currentJob = $derived.by((): {
    id: string;
    title: string;
    description: string | null;
    triggers: { signal: string }[];
  } | null => {
    const data = configQuery.data;
    if (!data) return null;
    const jobs = data.config.jobs;
    if (!jobs) return null;

    const jobIds = Object.keys(jobs);
    if (jobIds.length === 0) return null;

    // Multi-job: use selectedJobId; single-job: use the only job
    const jobId = selectedJobId ?? jobIds[0];
    const job = jobs[jobId];
    if (!job || typeof job !== "object") return null;

    const title = "title" in job && typeof job.title === "string" ? job.title : humanizeStepName(jobId);
    const description = "description" in job && typeof job.description === "string" ? job.description : null;
    const triggers = "triggers" in job && Array.isArray(job.triggers)
      ? job.triggers.filter((t): t is { signal: string } => typeof t === "object" && t !== null && "signal" in t)
      : [];
    return { id: jobId, title, description, triggers };
  });

  /** All workspace signals, keyed by ID. */
  const workspaceSignals = $derived.by((): Record<string, { description: string; title?: string; schema?: Record<string, unknown> }> => {
    const data = configQuery.data;
    if (!data?.config.signals) return {};
    const result: Record<string, { description: string; title?: string; schema?: Record<string, unknown> }> = {};
    for (const [id, sig] of Object.entries(data.config.signals)) {
      result[id] = {
        description: sig.description,
        title: sig.title,
        schema: sig.schema,
      };
    }
    return result;
  });

  const hasOnlyUnsupported = $derived(
    topology !== null &&
      topology.nodes.filter((n) => n.type !== "signal").length === 0 &&
      topology.unsupportedJobs &&
      topology.unsupportedJobs.length > 0,
  );

  // ---------------------------------------------------------------------------
  // Living Blueprint — session status on pipeline
  // ---------------------------------------------------------------------------

  const sessionsQuery = useSessionsQuery(() => workspaceId);

  /** Most recent relevant session: active > completed/failed */
  const latestSession = $derived.by((): SessionSummary | null => {
    const sessions = sessionsQuery.data;
    if (!sessions || sessions.length === 0) return null;
    // Prefer active session, otherwise take the most recent
    const active = sessions.find((s) => s.status === "active");
    return active ?? sessions[0] ?? null;
  });

  /** Fetch full SessionView for the latest session to get agent blocks */
  const sessionViewQuery = createQuery(() => {
    const session = latestSession;
    const id = session?.sessionId ?? null;
    return {
      queryKey: ["session-view", id],
      queryFn: async () => {
        if (!id) throw new Error("No session");
        return fetchSessionView(id);
      },
      enabled: id !== null,
      refetchInterval: latestSession?.status === "active" ? 3_000 : false,
    };
  });

  /** Map session execution state to topology node statuses */
  const stepStatuses = $derived.by((): Map<string, StepStatus> | null => {
    const view = sessionViewQuery.data;
    if (!view || !topology) return null;
    return mapSessionToStepStatus(view, topology);
  });

  /** Session info for step counter */
  const sessionInfo = $derived.by(() => {
    const session = latestSession;
    if (!session) return null;
    return {
      status: session.status,
      durationMs: session.durationMs,
    };
  });

  /** Derive data contracts for the below-pipeline section. */
  const dataContracts = $derived.by(() => {
    const data = configQuery.data;
    if (!data) return [];
    return deriveDataContracts(data.config);
  });

  /** Derive signal details for the below-pipeline section. */
  const signalDetails = $derived.by(() => {
    const data = configQuery.data;
    if (!data) return [];
    return deriveSignalDetails(data.config);
  });

  /** Navigate to a pipeline step from a below-pipeline section click. */
  function navigateToStep(jobId: string, stepId: string) {
    if (!workspaceId) return;
    goto(`/platform/${workspaceId}/agent/${jobId}:${stepId}`);
  }
</script>

<div class="cockpit">
  {#if !workspaceId}
    <div class="empty-state">
      <p>No workspace selected</p>
      <p class="hint">Select a workspace from the sidebar to view its pipeline</p>
    </div>
  {:else if configQuery.isLoading}
    <div class="empty-state">
      <p class="hint">Loading workspace configuration...</p>
    </div>
  {:else if configQuery.isError}
    <div class="empty-state">
      <p>Failed to load workspace config</p>
      <p class="hint">{configQuery.error?.message}</p>
    </div>
  {:else if hasOnlyUnsupported}
    <div class="empty-state">
      <p>Execution-mode jobs only</p>
      <p class="hint">
        This workspace uses execution-mode jobs which aren't supported in the pipeline view.
        Migrate to FSM-based jobs to see them here.
      </p>
    </div>
  {:else if topology}
    <div class="workspace-identity">
      {#if configQuery.data}
        <div class="workspace-header">
          <h1 class="workspace-name">{configQuery.data.config.workspace.name}</h1>
          {#if configQuery.data.config.workspace.description}
            <p class="workspace-description">{configQuery.data.config.workspace.description}</p>
          {/if}
        </div>
      {/if}

      {#if workspaceAgents.length > 0}
        <div class="agents-section">
          <h2 class="section-label">Agents</h2>
          <AgentsStrip
            agents={workspaceAgents}
            {selectedAgentId}
            onAgentClick={selectWorkspaceAgent}
            {dimmedAgentIds}
          />
        </div>
      {/if}
    </div>

    {#if isMultiJob}
      <JobSelector
        jobs={jobInfos}
        {selectedJobId}
        onJobSelect={(id) => { selectedJobId = id; }}
      />
    {/if}

    {#if currentJob}
      <div class="jobs-section">
        <div class="jobs-header">
          <div class="jobs-header-left">
            <h2 class="section-label">Jobs</h2>
            <h3 class="job-title">{currentJob.title}</h3>
            {#if currentJob.description}
              <p class="job-description">{currentJob.description}</p>
            {/if}
          </div>
          {#if workspaceId && currentJob.triggers.length > 0}
            <RunJobDialog
              {workspaceId}
              jobId={currentJob.id}
              jobTitle={currentJob.title}
              signals={workspaceSignals}
              triggers={currentJob.triggers}
            />
          {/if}
        </div>
      </div>
    {/if}

    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div class="diagram-area" onclick={(e) => {
      if (e.target === e.currentTarget) clearSelection();
    }}>
      {#if scopedTopology}
      <PipelineDiagram
        topology={scopedTopology}
        {selectedNodeId}
        onNodeClick={selectNode}
      />
      {/if}
    </div>

    {#if workspaceId && scopedDataContracts.length > 0}
      <DataContractsPanel
        contracts={scopedDataContracts}
        {workspaceId}
        onStepClick={navigateToStep}
      />
    {/if}

    {#if workspaceId && signalDetails.length > 0}
      <SignalsPanel
        signals={signalDetails}
        {workspaceId}
        highlightedJobId={selectedJobId}
      />
    {/if}
  {/if}
</div>

<style>
  .cockpit {
    display: flex;
    flex: 1;
    flex-direction: column;
    padding: var(--size-12) var(--size-14) var(--size-12) var(--size-14);
  }

  .workspace-identity {
    border-block-end: 1px solid var(--color-border-1);
  }

  .workspace-header {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    padding-block-end: var(--size-4);
  }

  .workspace-name {
    color: var(--color-text);
    font-size: var(--font-size-8);
    font-weight: var(--font-weight-7);
    line-height: var(--font-lineheight-1);
    margin: 0;
  }

  .workspace-description {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-3);
    line-height: var(--font-lineheight-3);
    margin: 0;
    max-inline-size: 56ch;
  }

  .agents-section {
    border-block-start: 1px solid var(--color-border-1);
    display: flex;
    flex-direction: column;
  }

  .section-label {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-6);
    letter-spacing: var(--font-letterspacing-2);
    margin: 0;
    padding-block-end: var(--size-2);
    text-transform: uppercase;
  }

  .jobs-section {
    border-block-start: 1px solid var(--color-border-1);
    display: flex;
    flex-direction: column;
    padding-block-start: var(--size-3);
  }

  .jobs-header {
    align-items: flex-start;
    display: flex;
    gap: var(--size-4);
    justify-content: space-between;
  }

  .jobs-header-left {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
    min-inline-size: 0;
  }

  .job-title {
    color: var(--color-text);
    font-size: var(--font-size-4);
    font-weight: var(--font-weight-6);
    line-height: var(--font-lineheight-1);
    margin: 0;
  }

  .job-description {
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    display: -webkit-box;
    font-size: var(--font-size-2);
    line-clamp: 2;
    line-height: var(--font-lineheight-3);
    margin: 0;
    max-inline-size: 56ch;
    overflow: hidden;
  }

  .diagram-area {
    display: flex;
    flex: 1;
    flex-direction: column;
  }

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
