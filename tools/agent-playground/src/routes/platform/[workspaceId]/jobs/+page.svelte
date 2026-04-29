<!--
  Jobs page — flat list of workspace jobs, styled after the MCP page.

  Each job renders as a grid row (name + trigger badges + actions) with
  description, config strip, agent chips, and skills summary expanding
  below in full-width grid cells.

  @component
-->

<script lang="ts">
  import { deriveJobAgents } from "@atlas/config/job-agents";
  import {
    extractInitialStateIds,
    filterNoiseNodes,
    humanizeStepName,
  } from "@atlas/config/pipeline-utils";
  import { deriveSignalDetails, type SignalDetail } from "@atlas/config/signal-details";
  import { deriveTopology } from "@atlas/config/topology";
  import { deriveWorkspaceAgents, type WorkspaceAgent } from "@atlas/config/workspace-agents";
  import { Button, DropdownMenu } from "@atlas/ui";
  import { createQuery } from "@tanstack/svelte-query";
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import InlineBadge from "$lib/components/shared/inline-badge.svelte";
  import PipelineDiagram from "$lib/components/workspace/pipeline-diagram.svelte";
  import RunJobDialog from "$lib/components/workspace/run-job-dialog.svelte";
  import WorkspaceBreadcrumb from "$lib/components/workspace/workspace-breadcrumb.svelte";
  import { humanizeCronSchedule } from "$lib/cron-humanize";
  import { externalDaemonUrl } from "$lib/daemon-url";
  import { integrationQueries, workspaceQueries, type IntegrationStatus } from "$lib/queries";
  import { JsonSchemaObjectShape, JsonSchemaPropertyShape } from "$lib/schema-utils";

  const workspaceId = $derived(page.params.workspaceId ?? null);
  const configQuery = createQuery(() => workspaceQueries.config(workspaceId));
  let searchQuery = $state("");

  const topology = $derived.by(() => {
    const data = configQuery.data;
    if (!data) return null;
    const raw = deriveTopology(data.config);
    const initialIds = extractInitialStateIds(data.config);
    return filterNoiseNodes(raw, initialIds);
  });

  interface JobEntry {
    id: string;
    title: string;
    description: string | null;
    triggers: { signal: string }[];
  }

  const jobEntries = $derived.by((): JobEntry[] => {
    const data = configQuery.data;
    if (!data) return [];
    const jobs = data.config.jobs;
    if (!jobs) return [];
    return Object.entries(jobs).map(([id, job]) => {
      const rec = job as Record<string, unknown>;
      const title = typeof rec?.title === "string" ? rec.title : humanizeStepName(id);
      const description = typeof rec?.description === "string" ? rec.description : null;
      const triggers = Array.isArray(rec?.triggers)
        ? (rec.triggers as unknown[]).filter(
            (t): t is { signal: string } => typeof t === "object" && t !== null && "signal" in t,
          )
        : [];
      return { id, title, description, triggers };
    });
  });

  const filteredJobEntries = $derived.by((): JobEntry[] => {
    const query = searchQuery.trim().toLowerCase();
    if (query.length === 0) return jobEntries;
    return jobEntries.filter((job) => {
      const haystack = [
        job.id,
        job.title,
        job.description ?? "",
        ...job.triggers.map((trigger) => trigger.signal),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  });

  const workspaceSignals = $derived.by(
    (): Record<
      string,
      { description: string; title?: string; schema?: Record<string, unknown> }
    > => {
      const data = configQuery.data;
      if (!data?.config.signals) return {};
      const result: Record<
        string,
        { description: string; title?: string; schema?: Record<string, unknown> }
      > = {};
      for (const [id, sig] of Object.entries(data.config.signals)) {
        result[id] = { description: sig.description, title: sig.title, schema: sig.schema };
      }
      return result;
    },
  );

  const signalDetails = $derived.by(() => {
    const data = configQuery.data;
    if (!data) return [];
    return deriveSignalDetails(data.config);
  });

  function signalsForJob(jobId: string): SignalDetail[] {
    return signalDetails.filter((s) => s.triggeredJobs.includes(jobId));
  }

  const preflightQuery = createQuery(() => integrationQueries.preflight(workspaceId));
  const workspaceAgents = $derived.by(() => {
    const data = configQuery.data;
    if (!data) return [];
    return deriveWorkspaceAgents(data.config);
  });

  const providerStatus = $derived.by((): Map<string, IntegrationStatus> => {
    const map = new Map<string, IntegrationStatus>();
    for (const entry of preflightQuery.data?.integrations ?? []) {
      map.set(entry.provider, entry.status);
    }
    return map;
  });

  function agentsForJob(jobId: string): WorkspaceAgent[] {
    const data = configQuery.data;
    if (!data) return [];
    const jobs = data.config.jobs;
    if (!jobs) return [];
    const rawJob = jobs[jobId];
    if (!rawJob) return [];
    const agentIds = deriveJobAgents(rawJob as Record<string, unknown>);
    return agentIds
      .map((id) => workspaceAgents.find((a) => a.id === id))
      .filter((a): a is WorkspaceAgent => a !== undefined);
  }

  function agentHealth(agent: WorkspaceAgent): IntegrationStatus | null {
    const providers: string[] = [];
    for (const [, value] of Object.entries(agent.env)) {
      if (
        typeof value === "object" &&
        value !== null &&
        "from" in value &&
        (value as Record<string, unknown>).from === "link"
      ) {
        const provider =
          (value as Record<string, unknown>).provider ?? (value as Record<string, unknown>).id;
        if (typeof provider === "string") providers.push(provider);
      }
    }
    if (providers.length === 0) return null;

    const STATUS_PRIORITY: Record<IntegrationStatus, number> = {
      connected: 2,
      degraded: 1,
      disconnected: 0,
    };
    let worst: IntegrationStatus = "connected";
    for (const p of providers) {
      const status = providerStatus.get(p) ?? "disconnected";
      if (STATUS_PRIORITY[status] < STATUS_PRIORITY[worst]) {
        worst = status;
      }
    }
    return worst;
  }

  function typeBadge(agent: WorkspaceAgent): string {
    if (agent.agent) return agent.agent;
    if (agent.type === "llm") return "LLM";
    return agent.type;
  }

  function providerLabel(provider: string): string {
    if (provider === "http") return "HTTP";
    if (provider === "schedule") return "SCHEDULE";
    return provider.toUpperCase();
  }

  function triggerStrip(signal: SignalDetail): string {
    if (signal.endpoint) return `POST ${signal.endpoint}`;
    if (signal.schedule) return signal.schedule;
    return signal.name;
  }

  function scopeTopologyToJob(jobId: string) {
    if (!topology) return null;
    const jobSignalIds = new Set(signalsForJob(jobId).map((s) => `signal:${s.name}`));
    const nodes = topology.nodes.filter((node) => {
      if (node.jobId) return node.jobId === jobId;
      if (node.type === "signal") return jobSignalIds.has(node.id);
      return true;
    });
    const nodeIds = new Set(nodes.map((node) => node.id));
    return {
      ...topology,
      nodes,
      edges: topology.edges.filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to)),
    };
  }

  function buildBodyFromSchema(schema: Record<string, unknown> | undefined): string {
    if (!schema) return "{}";
    const parsed = JsonSchemaObjectShape.safeParse(schema);
    if (!parsed.success || !parsed.data.properties) return "{}";

    const entries: Record<string, unknown> = {};
    for (const [key, rawDef] of Object.entries(parsed.data.properties)) {
      const prop = JsonSchemaPropertyShape.safeParse(rawDef);
      const t = prop.success ? prop.data.type : undefined;
      if (t === "number" || t === "integer") entries[key] = 0;
      else if (t === "boolean") entries[key] = false;
      else if (t === "array") entries[key] = [];
      else if (t === "object") entries[key] = {};
      else entries[key] = "";
    }
    return (
      "{ " +
      Object.entries(entries)
        .map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`)
        .join(", ") +
      " }"
    );
  }

  function handleMenuAction(job: JobEntry, action: string) {
    if (action === "copy-curl") {
      const trigger = job.triggers[0];
      if (trigger) {
        const signal = workspaceSignals[trigger.signal];
        const body = buildBodyFromSchema(signal?.schema);
        const escaped = body.replace(/'/g, "'\\''");
        const curl = [
          "curl -X POST",
          `-H 'Content-Type: application/json'`,
          `-d '${escaped}'`,
          `${externalDaemonUrl()}/api/workspaces/${workspaceId}/signals/${trigger.signal}`,
        ].join(" \\\n  ");
        navigator.clipboard.writeText(curl);
      }
    } else if (action === "copy-cli") {
      const trigger = job.triggers[0];
      const signalName = trigger?.signal ?? job.id;
      const signal = trigger ? workspaceSignals[trigger.signal] : undefined;
      const body = buildBodyFromSchema(signal?.schema);
      const escaped = body.replace(/'/g, "'\\''");
      const cmd = `docker compose exec platform atlas signal trigger ${signalName} --workspace ${workspaceId} --data '${escaped}'`;
      navigator.clipboard.writeText(cmd);
    }
  }
</script>

<div class="jobs-page">
  {#if workspaceId}
    <WorkspaceBreadcrumb {workspaceId} section="Jobs" />
  {/if}

  {#if configQuery.isLoading}
    <div class="empty-state"><p>Loading jobs…</p></div>
  {:else if configQuery.isError}
    <div class="empty-state">
      <p>Failed to load workspace config</p>
      <span class="empty-hint">{configQuery.error?.message ?? ""}</span>
    </div>
  {:else}
    <section class="section">
      <header class="page-header">
        <div class="header-info">
          <h1 class="page-title">Jobs</h1>
          <p class="section-description">
            Jobs are workflows that can be triggered by signals. Review each job's trigger, flow,
            and assigned agents, or run and manage a job directly from this page.
          </p>
        </div>
        <span class="count">{filteredJobEntries.length}</span>
      </header>

      <section class="search-section">
        <div class="search-row">
          <input
            class="search-input"
            type="text"
            bind:value={searchQuery}
            placeholder="Filter jobs…"
            autocomplete="off"
          />
        </div>
      </section>

      {#if jobEntries.length === 0}
        <p class="empty-hint">
          No jobs configured. Add jobs to your workspace.yml to see them here.
        </p>
      {:else if filteredJobEntries.length === 0}
        <p class="empty-hint">No jobs match your filter.</p>
      {:else}
        <div class="job-list">
          {#each filteredJobEntries as job (job.id)}
            {@const jobAgents = agentsForJob(job.id)}
            {@const jobSignals = signalsForJob(job.id)}
            {@const jobTopology = scopeTopologyToJob(job.id)}
            <div class="job-row" id="job-{job.id}">
              <a
                class="row-main"
                href={resolve("/platform/[workspaceId]/jobs/[jobName]", {
                  workspaceId: workspaceId ?? "",
                  jobName: job.id,
                })}
              >
                <span
                  class="job-dot"
                  class:schedule={jobSignals.some((signal) => signal.provider === "schedule")}
                ></span>
                <span class="job-name">{job.title}</span>
                {#each jobSignals as signal (signal.name)}
                  <InlineBadge variant={signal.provider === "schedule" ? "warning" : "info"}>
                    {providerLabel(signal.provider)}
                  </InlineBadge>
                {/each}
              </a>

              <div class="row-actions">
                <Button
                  size="small"
                  href={resolve("/platform/[workspaceId]/jobs/[jobName]", {
                    workspaceId: workspaceId ?? "",
                    jobName: job.id,
                  })}
                >
                  Manage
                </Button>
                {#if workspaceId && job.triggers.length > 0}
                  <RunJobDialog
                    {workspaceId}
                    jobId={job.id}
                    jobTitle={job.title}
                    signals={workspaceSignals}
                    triggers={job.triggers}
                  />
                {/if}

                <DropdownMenu.Root positioning={{ placement: "bottom-end", gutter: 10 }}>
                  <DropdownMenu.Trigger class="overflow-trigger" aria-label="Job options">
                    <span class="overflow-btn">&hellip;</span>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Content>
                    <DropdownMenu.Item
                      onclick={() =>
                        goto(
                          resolve("/platform/[workspaceId]/jobs/[jobName]", {
                            workspaceId: workspaceId ?? "",
                            jobName: job.id,
                          }),
                        )}
                    >
                      Manage skills
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      onclick={() =>
                        goto(
                          resolve("/inspector", {}) +
                            `?workspace=${encodeURIComponent(workspaceId ?? "")}&job=${encodeURIComponent(job.id)}`,
                        )}
                    >
                      Open in Job Inspector
                    </DropdownMenu.Item>
                    <DropdownMenu.Item onclick={() => handleMenuAction(job, "copy-curl")}>
                      Copy as cURL
                    </DropdownMenu.Item>
                    <DropdownMenu.Item onclick={() => handleMenuAction(job, "copy-cli")}>
                      Copy CLI command
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      onclick={() =>
                        goto(
                          resolve("/platform/[workspaceId]/edit", {
                            workspaceId: workspaceId ?? "",
                          }) + `?path=jobs.${encodeURIComponent(job.id)}`,
                        )}
                    >
                      Edit configuration
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Root>
              </div>

              {#if job.description}
                <p class="row-description">{job.description}</p>
              {/if}

              {#if jobSignals.length > 0}
                <div class="row-signals" aria-label="Triggers">
                  {#each jobSignals as signal (signal.name)}
                    <div class="signal-config">
                      <span class="signal-type">
                        {signal.provider === "schedule"
                          ? "Schedule"
                          : providerLabel(signal.provider)}
                      </span>
                      {#if signal.provider === "schedule" && signal.schedule}
                        <span class="signal-summary" title={signal.schedule}>
                          {humanizeCronSchedule(signal.schedule, signal.timezone ?? "UTC")}
                        </span>
                      {:else}
                        <span class="signal-summary">{triggerStrip(signal)}</span>
                      {/if}
                    </div>
                  {/each}
                </div>
              {/if}

              <div class="row-details">
                {#if jobTopology && jobTopology.nodes.length > 0}
                  <div class="detail-block detail-block-flow">
                    <span class="detail-label">Flow</span>
                    <PipelineDiagram topology={jobTopology} compact />
                  </div>
                {/if}

                {#if jobAgents.length > 0}
                  <div class="detail-block">
                    <span class="detail-label">Agents</span>
                    <div class="agent-chips">
                      {#each jobAgents as agent (agent.id)}
                        {@const health = agentHealth(agent)}
                        <a
                          class="agent-chip"
                          href={resolve("/platform/[workspaceId]/agents", {
                            workspaceId: workspaceId ?? "",
                          }) + `#agent-${agent.id}`}
                        >
                          {#if health !== null}
                            <span
                              class="health-dot"
                              class:connected={health === "connected"}
                              class:degraded={health === "degraded"}
                              class:disconnected={health === "disconnected"}
                            ></span>
                          {/if}
                          <span class="chip-name">{agent.name}</span>
                          <InlineBadge variant="success">{typeBadge(agent)}</InlineBadge>
                        </a>
                      {/each}
                    </div>
                  </div>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </section>
  {/if}
</div>

<style>
  .jobs-page {
    display: flex;
    flex-direction: column;
    gap: var(--size-6);
    padding: var(--size-8) var(--size-10);
  }

  .search-section {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    padding-block: var(--size-4) var(--size-5);
  }

  .search-row {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--size-3);
  }

  .search-input {
    background: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    color: var(--color-text);
    font-family: inherit;
    font-size: inherit;
    inline-size: 100%;
    padding: var(--size-2) var(--size-3);
  }

  .empty-state {
    align-items: center;
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    padding: var(--size-16) 0;
  }

  .section {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .page-header {
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

  .page-title {
    color: var(--color-text);
    font-size: var(--font-size-8);
    font-weight: var(--font-weight-7);
    line-height: var(--font-lineheight-1);
    margin: 0;
  }

  .count {
    color: color-mix(in srgb, var(--color-text), transparent 45%);
    font-size: var(--font-size-3);
  }

  .section-description {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-size: var(--font-size-3);
    line-height: 1.6;
    margin: 0;
    max-inline-size: 68ch;
  }

  .empty-hint {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-3);
    margin: 0;
    padding-block-start: var(--size-2);
  }

  /* ---- Job list ---- */

  .job-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-5);
  }

  .job-row {
    align-items: start;
    column-gap: var(--size-4);
    display: grid;
    grid-template-columns: 1fr auto;
    padding: var(--size-5) var(--size-4);
    position: relative;
    z-index: 1;
  }

  /* ---- Row: main header line ---- */

  .row-main {
    align-items: center;
    color: inherit;
    display: flex;
    gap: var(--size-3);
    min-inline-size: 0;
    padding-block-start: var(--size-1);
    text-decoration: none;
  }

  .job-dot {
    background-color: var(--color-info);
    block-size: 8px;
    border-radius: 50%;
    flex-shrink: 0;
    inline-size: 8px;
  }

  .job-dot.schedule {
    background-color: var(--color-warning);
  }

  .job-name {
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-6);
  }

  /* ---- Row: actions ---- */

  .row-actions {
    align-items: center;
    display: flex;
    gap: var(--size-2);
    position: relative;
    z-index: 2;
  }

  .row-actions :global(.overflow-trigger) {
    border-radius: var(--radius-2);
  }

  .overflow-btn {
    align-items: center;
    border-radius: var(--radius-2);
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    display: flex;
    font-size: var(--font-size-3);
    justify-content: center;
    line-height: 1;
    padding: var(--size-1) var(--size-2);
  }

  :global(.overflow-trigger):hover .overflow-btn {
    background: var(--color-surface-2);
    color: var(--color-text);
  }

  /* ---- Spanning row content ---- */

  .row-description {
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    font-size: var(--font-size-3);
    grid-column: 1 / -1;
    line-height: 1.65;
    margin: 0;
    overflow: hidden;
    padding-block-start: var(--size-3);
    padding-inline-start: calc(8px + var(--size-3));
  }

  .row-signals {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
    grid-column: 1 / -1;
    padding-block-start: var(--size-3);
    padding-inline-start: calc(8px + var(--size-3));
  }

  .signal-config {
    align-items: baseline;
    color: color-mix(in srgb, var(--color-text), transparent 28%);
    display: flex;
    gap: var(--size-2);
    min-inline-size: 0;
  }

  .signal-config::before {
    color: color-mix(in srgb, var(--color-text), transparent 60%);
    content: "•";
  }

  .signal-type {
    color: color-mix(in srgb, var(--color-text), transparent 45%);
    flex: 0 0 auto;
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-6);
  }

  .signal-summary {
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    font-size: var(--font-size-3);
  }

  .row-details {
    background: color-mix(in srgb, var(--color-surface-2), transparent 62%);
    border-radius: var(--radius-4);
    display: grid;
    gap: var(--size-8);
    grid-column: 1 / -1;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    margin-block-start: var(--size-5);
    margin-inline-start: 0;
    padding: var(--size-5) var(--size-5) var(--size-5) calc(8px + var(--size-3));
    position: relative;
    z-index: 2;
  }

  .detail-block {
    align-content: start;
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
    min-inline-size: 0;
  }

  .detail-label {
    color: color-mix(in srgb, var(--color-text), transparent 45%);
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-6);
    letter-spacing: var(--font-letterspacing-1);
    text-transform: uppercase;
  }

  .detail-block-flow :global(.pipeline--compact) {
    flex-wrap: wrap;
    overflow: visible;
  }

  .detail-block-flow :global(.pill),
  .jobs-page :global(.button.size-small) {
    font-size: var(--font-size-3);
  }

  .jobs-page :global(.inline-badge) {
    font-size: var(--font-size-1);
  }

  .detail-block-flow :global(.pill) {
    block-size: var(--size-7);
    padding-inline: var(--size-2-5);
  }

  .agent-chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--size-3);
  }

  .agent-chip {
    align-items: center;
    background: var(--color-surface-2);
    border: none;
    border-radius: var(--radius-pill, 9999px);
    color: inherit;
    display: inline-flex;
    gap: var(--size-1);
    min-block-size: var(--size-7);
    padding: 0 var(--size-2-5);
    text-decoration: none;
    transition: background 80ms ease;
  }

  .agent-chip:hover {
    background: color-mix(in srgb, var(--color-surface-2), var(--color-text) 6%);
  }

  .health-dot {
    background-color: color-mix(in srgb, var(--color-text), transparent 70%);
    block-size: 6px;
    border-radius: 50%;
    flex-shrink: 0;
    inline-size: 6px;
  }

  .health-dot.connected {
    background-color: var(--color-success);
  }

  .health-dot.degraded {
    background-color: var(--color-warning);
  }

  .health-dot.disconnected {
    background-color: var(--color-error);
  }

  .chip-name {
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-5);
    line-height: 1;
    padding-inline-end: var(--size-1);
  }

  @media (max-width: 900px) {
    .row-details {
      grid-template-columns: 1fr;
    }
  }
</style>
