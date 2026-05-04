<script lang="ts">
  import { deriveAgentJobUsage } from "@atlas/config/agent-job-usage";
  import { humanizeStepName } from "@atlas/config/pipeline-utils";
  import { deriveSignalDetails } from "@atlas/config/signal-details";
  import { deriveTopology } from "@atlas/config/topology";
  import { deriveWorkspaceAgents } from "@atlas/config/workspace-agents";
  import { Page } from "@atlas/ui";
  import { createQuery } from "@tanstack/svelte-query";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import AgentEditorSidebar from "$lib/components/agents/agent-editor-sidebar.svelte";
  import AgentIndexSidebar from "$lib/components/agents/agent-index-sidebar.svelte";
  import WorkspaceAgentSidebar from "$lib/components/agents/workspace-agent-sidebar.svelte";
  import SidebarIdleView from "$lib/components/shared/sidebar-idle-view.svelte";
  import SkillIndexSidebar from "$lib/components/skills/skill-index-sidebar.svelte";
  import JobIndexSidebar, {
    type JobEntry,
  } from "$lib/components/workspace/job-index-sidebar.svelte";
  import SignalSidebar from "$lib/components/workspace/signal-sidebar.svelte";
  import {
    integrationQueries,
    skillQueries,
    workspaceQueries,
    type IntegrationStatus,
  } from "$lib/queries";

  const { children } = $props();

  const workspaceId = $derived(page.params.workspaceId ?? null);
  const configQuery = createQuery(() => workspaceQueries.config(workspaceId));
  const config = $derived(configQuery.data?.config ?? null);

  /** Derive selected node from URL route params + topology lookup. */
  const selectedNode = $derived.by(() => {
    const signalId = page.params.signalId;
    const nodeId = page.params.nodeId;
    if (!signalId && !nodeId) return null;

    if (!config) return null;
    const topology = deriveTopology(config);
    const targetId = signalId ? `signal:${signalId}` : nodeId;
    return topology.nodes.find((n) => n.id === targetId) ?? null;
  });

  /** Derive selected workspace agent from route params. */
  const selectedWorkspaceAgent = $derived.by(() => {
    const agentId = page.params.agentId;
    if (!agentId || !config) return null;
    const agents = deriveWorkspaceAgents(config);
    return agents.find((a) => a.id === agentId) ?? null;
  });

  /** Derive agent-to-step usage map for "Used In" sidebar section. */
  const agentJobUsage = $derived(config ? deriveAgentJobUsage(config) : new Map());

  /** Navigate to a pipeline step node from the "Used In" section. */
  function handleStepClick(jobId: string, stepId: string) {
    if (!workspaceId) return;
    goto(`/platform/${workspaceId}/agent/${jobId}:${stepId}`);
  }

  /** Session detail pages manage their own sidebar layout. */
  const isSessionDetail = $derived(!!page.params.sessionId);

  /** Signal detail page is self-contained — no layout sidebar needed. */
  const isSignalDetail = $derived(!!page.params.signalId);

  /** Overview page uses a full-width dashboard grid — no sidebar needed. */
  const isOverview = $derived(page.route.id === "/platform/[workspaceId]");

  /** Edit page is full-screen editor — no sidebar. */
  const isEdit = $derived(page.route.id === "/platform/[workspaceId]/edit");

  /** Chat page is full-width — no sidebar. The chat page manages its own
   * scroll, so we disable layout scrolling for it. Sub-routes under /chat
   * (like /chat/[[chatId]]/debug) want normal layout scroll, so we match
   * the chat route id exactly rather than via startsWith. */
  const isChat = $derived(page.route.id === "/platform/[workspaceId]/chat/[[chatId]]");

  /** Debug view for a chat — no sidebar (full-width dump), but normal page scroll. */
  const isChatDebug = $derived(page.route.id === "/platform/[workspaceId]/chat/[[chatId]]/debug");

  /** Agents page renders its own sidebar content (agent index). */
  const isAgents = $derived(page.route.id === "/platform/[workspaceId]/agents");

  /** Jobs page renders job index sidebar. */
  const isJobs = $derived(page.route.id === "/platform/[workspaceId]/jobs");

  /** Skills page renders skill index sidebar. */
  const isSkills = $derived(page.route.id === "/platform/[workspaceId]/skills");

  // --- Agent index sidebar data (TanStack Query deduplicates with agents page) ---
  const preflightQuery = createQuery(() => integrationQueries.preflight(workspaceId));
  const workspaceAgents = $derived(config ? deriveWorkspaceAgents(config) : []);
  const providerStatus = $derived.by((): Map<string, IntegrationStatus> => {
    const map = new Map<string, IntegrationStatus>();
    for (const entry of preflightQuery.data?.integrations ?? []) {
      map.set(entry.provider, entry.status);
    }
    return map;
  });

  // --- Job index sidebar data ---
  const jobEntries = $derived.by((): JobEntry[] => {
    if (!config?.jobs) return [];
    return Object.entries(config.jobs).map(([id, job]) => {
      const rec = job as Record<string, unknown>;
      const title = typeof rec?.title === "string" ? rec.title : humanizeStepName(id);
      const triggers = Array.isArray(rec?.triggers)
        ? (rec.triggers as unknown[]).filter(
            (t): t is { signal: string } => typeof t === "object" && t !== null && "signal" in t,
          )
        : [];
      return { id, title, triggers };
    });
  });

  // --- Skill index sidebar data ---
  const skillsQuery = createQuery(() => skillQueries.workspaceSkills(workspaceId));
  const workspaceSkillCount = $derived(
    Array.isArray(skillsQuery.data) ? skillsQuery.data.length : 0,
  );

  function openSkillPicker() {
    if (!workspaceId) return;
    goto(`/platform/${workspaceId}/skills?addSkill=true`);
  }

  const signalDetails = $derived(config ? deriveSignalDetails(config) : []);

  /** Escape key returns to idle sidebar. */
  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && workspaceId && (selectedNode || selectedWorkspaceAgent)) {
      goto(`/platform/${workspaceId}`);
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<svelte:window onkeydown={handleKeydown} />

<Page.Root>
  <Page.Content scrollable={!isChat} padded={false}>
    {@render children?.()}
  </Page.Content>
  {#if !isSessionDetail && !isSignalDetail && !isOverview && !isEdit && !isChat && !isChatDebug}
    <Page.Sidebar>
      {#if isAgents}
        <AgentIndexSidebar agents={workspaceAgents} {providerStatus} />
      {:else if isJobs}
        <JobIndexSidebar jobs={jobEntries} {signalDetails} workspaceId={workspaceId ?? ""} />
      {:else if isSkills}
        <SkillIndexSidebar onadd={openSkillPicker} skillCount={workspaceSkillCount} />
      {:else}
        {#key selectedNode?.id ?? selectedWorkspaceAgent?.id}
          {#if selectedWorkspaceAgent}
            <WorkspaceAgentSidebar
              agent={selectedWorkspaceAgent}
              usedIn={agentJobUsage.get(selectedWorkspaceAgent.id) ?? []}
              onStepClick={handleStepClick}
            />
          {:else if selectedNode}
            {#if selectedNode.type === "signal" && workspaceId}
              <SignalSidebar node={selectedNode} {workspaceId} />
            {:else if selectedNode.type === "agent-step" && workspaceId}
              <AgentEditorSidebar node={selectedNode} {workspaceId} {config} />
            {:else}
              <div class="sidebar-section">
                <h3 class="sidebar-title">{selectedNode.label}</h3>
                <p class="sidebar-meta">Terminal node</p>
              </div>
            {/if}
          {:else if workspaceId}
            <SidebarIdleView {workspaceId} {config} />
          {/if}
        {/key}
      {/if}
    </Page.Sidebar>
  {/if}
</Page.Root>

<style>
  .sidebar-section {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .sidebar-title {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    letter-spacing: var(--font-letterspacing-2);
    text-transform: uppercase;
  }

  .sidebar-meta {
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    font-size: var(--font-size-2);
  }
</style>
