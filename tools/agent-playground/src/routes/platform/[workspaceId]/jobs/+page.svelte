<!--
  Jobs page — card-list layout showing all workspace jobs.

  Each job renders as an always-expanded card with header (title, Run button,
  overflow menu), full description, and embedded pipeline topology diagram.

  @component
-->

<script lang="ts">
  import { deriveDataContracts, type DataContract } from "@atlas/config/data-contracts";
  import { deriveJobAgents } from "@atlas/config/job-agents";
  import {
    extractInitialStateIds,
    filterNoiseNodes,
    humanizeStepName,
  } from "@atlas/config/pipeline-utils";
  import { deriveSignalDetails, type SignalDetail } from "@atlas/config/signal-details";
  import { deriveTopology } from "@atlas/config/topology";
  import { deriveWorkspaceAgents, type WorkspaceAgent } from "@atlas/config/workspace-agents";
  import { DropdownMenu } from "@atlas/ui";
  import { createQuery } from "@tanstack/svelte-query";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import SchemaBlock from "$lib/components/shared/schema-block.svelte";
  import PipelineDiagram from "$lib/components/workspace/pipeline-diagram.svelte";
  import RunJobDialog from "$lib/components/workspace/run-job-dialog.svelte";
  import WorkspaceBreadcrumb from "$lib/components/workspace/workspace-breadcrumb.svelte";
  import { EXTERNAL_DAEMON_URL } from "$lib/daemon-url";
  import { integrationQueries, workspaceQueries, type IntegrationStatus } from "$lib/queries";
  import { JsonSchemaObjectShape, JsonSchemaPropertyShape } from "$lib/schema-utils";

  const workspaceId = $derived(page.params.workspaceId ?? null);

  const configQuery = createQuery(() => workspaceQueries.config(workspaceId));

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

  /** Workspace signals keyed by ID for the RunJobDialog. */
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

  /** Get signals that trigger a specific job. */
  function signalsForJob(jobId: string): SignalDetail[] {
    return signalDetails.filter((s) => s.triggeredJobs.includes(jobId));
  }

  const dataContracts = $derived.by(() => {
    const data = configQuery.data;
    if (!data) return [];
    return deriveDataContracts(data.config);
  });

  /** Get data contracts for a specific job. */
  function contractsForJob(jobId: string): DataContract[] {
    return dataContracts.filter((c) => c.jobId === jobId);
  }

  // --- Agent health data ---
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

  /** Get workspace agent objects used in a specific job. */
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

  /** Extract schema properties for rendering. */
  function schemaFields(
    schema: object | null,
  ): Array<{ name: string; type: string; required: boolean; description?: string }> {
    if (!schema) return [];
    const parsed = JsonSchemaObjectShape.safeParse(schema);
    if (!parsed.success || !parsed.data.properties) return [];
    const requiredSet = new Set<string>(parsed.data.required ?? []);
    return Object.entries(parsed.data.properties).map(([name, rawDef]) => {
      const prop = JsonSchemaPropertyShape.safeParse(rawDef);
      const def = prop.success ? prop.data : undefined;
      return {
        name,
        type: def?.type ?? "unknown",
        required: requiredSet.has(name),
        ...(def?.description ? { description: def.description } : {}),
      };
    });
  }

  function providerLabel(provider: string): string {
    if (provider === "http") return "HTTP";
    if (provider === "schedule") return "CRON";
    return provider.toUpperCase();
  }

  /** Scope topology nodes/edges to a single job. */
  function scopeTopologyToJob(jobId: string) {
    if (!topology) return null;
    const jobSignalIds = new Set(signalsForJob(jobId).map((s) => `signal:${s.name}`));
    const nodes = topology.nodes.filter((n) => {
      if (n.jobId) return n.jobId === jobId;
      if (n.type === "signal") return jobSignalIds.has(n.id);
      return true;
    });
    const nodeIds = new Set(nodes.map((n) => n.id));
    return {
      ...topology,
      nodes,
      edges: topology.edges.filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to)),
    };
  }

  /** Build a placeholder JSON body from a signal's schema properties. */
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
          `${EXTERNAL_DAEMON_URL}/api/workspaces/${workspaceId}/signals/${trigger.signal}`,
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
    <WorkspaceBreadcrumb {workspaceId} />
  {/if}

  <header class="page-header">
    <h1>Jobs</h1>
    <p class="page-subtitle">
      Jobs define the execution pipelines in your workspace. Each job orchestrates a sequence of
      agent steps.
    </p>
  </header>

  {#if configQuery.isLoading}
    <div class="empty-state">
      <p>Loading jobs...</p>
    </div>
  {:else if configQuery.isError}
    <div class="empty-state">
      <p>Failed to load workspace config</p>
      <span class="empty-hint">{configQuery.error?.message}</span>
    </div>
  {:else if jobEntries.length === 0}
    <div class="empty-state">
      <p>No jobs configured</p>
      <span class="empty-hint">Add jobs to your workspace.yml to see them here</span>
    </div>
  {:else}
    <div class="job-list">
      {#each jobEntries as job (job.id)}
        {@const jobTopology = scopeTopologyToJob(job.id)}
        {@const jobContracts = contractsForJob(job.id)}
        {@const jobAgents = agentsForJob(job.id)}
        {@const jobSignals = signalsForJob(job.id)}
        <div class="job-card" id="job-{job.id}">
          <div class="card-header">
            <h2 class="job-title">{job.title}</h2>

            <div class="card-actions">
              <DropdownMenu.Root positioning={{ placement: "bottom-end" }}>
                {#snippet children()}
                  <DropdownMenu.Trigger class="overflow-trigger" aria-label="Job options">
                    <span class="overflow-btn">&hellip;</span>
                  </DropdownMenu.Trigger>

                  <DropdownMenu.Content>
                    <DropdownMenu.Item
                      onclick={() => goto(`/inspector?workspace=${workspaceId}&job=${job.id}`)}
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
                      onclick={() => goto(`/platform/${workspaceId}/edit?path=jobs.${job.id}`)}
                    >
                      Edit configuration
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                {/snippet}
              </DropdownMenu.Root>

              {#if workspaceId && job.triggers.length > 0}
                <RunJobDialog
                  {workspaceId}
                  jobId={job.id}
                  jobTitle={job.title}
                  signals={workspaceSignals}
                  triggers={job.triggers}
                />
              {/if}
            </div>
          </div>

          {#if job.description}
            <p class="job-description">{job.description}</p>
          {/if}

          {#if jobTopology && jobTopology.nodes.length > 0}
            <div class="diagram-area">
              <PipelineDiagram topology={jobTopology} />
            </div>
          {/if}

          {#if jobContracts.length > 0 && workspaceId}
            <div class="contracts-section">
              <h3 class="section-label">Data Contracts</h3>
              <div class="contracts-list">
                {#each jobContracts as contract (contract.fromStepId + ":" + contract.documentType)}
                  <SchemaBlock {contract} {workspaceId} />
                {/each}
              </div>
            </div>
          {/if}

          {#if jobAgents.length > 0}
            <div class="agents-section">
              <h3 class="section-label">Agents</h3>
              <div class="agents-list">
                {#each jobAgents as agent (agent.id)}
                  {@const health = agentHealth(agent)}
                  <a class="agent-row" href="/platform/{workspaceId}/agents#agent-{agent.id}">
                    {#if health !== null}
                      <span
                        class="health-dot"
                        class:connected={health === "connected"}
                        class:degraded={health === "degraded"}
                        class:disconnected={health === "disconnected"}
                      ></span>
                    {/if}
                    <span class="agent-name">{agent.name}</span>
                    <span class="agent-type-badge">{typeBadge(agent)}</span>
                  </a>
                {/each}
              </div>
            </div>
          {/if}

          {#if jobSignals.length > 0}
            <div class="signals-section">
              <h3 class="section-label">Triggers</h3>
              <div class="signals-list">
                {#each jobSignals as signal (signal.name)}
                  {@const fields = schemaFields(signal.schema)}
                  <div class="signal-entry">
                    <div class="signal-header">
                      <span class="signal-name">{signal.title ?? signal.name}</span>
                      <span class="provider-badge">{providerLabel(signal.provider)}</span>
                      {#if signal.endpoint}
                        <span class="signal-config">POST {signal.endpoint}</span>
                      {:else if signal.schedule}
                        <span class="signal-config">{signal.schedule}</span>
                      {/if}
                    </div>

                    {#if fields.length > 0}
                      <div class="schema-fields">
                        {#each fields as field (field.name)}
                          <div class="schema-row">
                            <span class="field-name">{field.name}</span>
                            <span class="field-type">{field.type}</span>
                            {#if field.required}
                              <span class="field-required">required</span>
                            {/if}
                            {#if field.description}
                              <span class="field-desc">{field.description}</span>
                            {/if}
                          </div>
                        {/each}
                      </div>
                    {/if}
                  </div>
                {/each}
              </div>
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .jobs-page {
    display: flex;
    flex-direction: column;
    gap: var(--size-6);
    padding: var(--size-8) var(--size-10);
  }

  .page-header {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);

    h1 {
      font-size: var(--font-size-7);
      font-weight: var(--font-weight-6);
    }
  }

  .page-subtitle {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-3);
    line-height: 1.5;
    max-inline-size: 50ch;
  }

  .empty-state {
    align-items: center;
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    padding: var(--size-16) 0;

    p {
      font-size: var(--font-size-4);
    }
  }

  .empty-hint {
    font-size: var(--font-size-2);
    opacity: 0.6;
  }

  .job-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
  }

  .job-card {
    background: var(--color-surface-1);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-3);
    display: flex;
    flex-direction: column;
    gap: var(--size-4);
    padding: var(--size-5) var(--size-6);
  }

  .card-header {
    align-items: center;
    display: flex;
    gap: var(--size-3);
  }

  .job-title {
    flex: 1;
    font-size: var(--font-size-4);
    font-weight: var(--font-weight-6);
    margin: 0;
    min-inline-size: 0;
  }

  .card-actions {
    align-items: center;
    display: flex;
    flex-shrink: 0;
    gap: var(--size-1);
  }

  .card-actions :global(.overflow-trigger) {
    border-radius: var(--radius-2);
  }

  .overflow-btn {
    align-items: center;
    border-radius: var(--radius-2);
    color: color-mix(in srgb, var(--color-text), transparent 50%);
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

  .job-description {
    color: color-mix(in srgb, var(--color-text), transparent 20%);
    font-size: var(--font-size-2);
    line-height: 1.5;
    margin: 0;
    max-inline-size: 60ch;
  }

  .diagram-area {
    border-block-start: 1px solid var(--color-border-1);
    display: flex;
    flex-direction: column;
    padding-block-start: var(--size-4);
  }

  /* ---- Data contracts section ---- */

  .contracts-section {
    border-block-start: 1px solid var(--color-border-1);
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
    padding-block-start: var(--size-4);
  }

  .contracts-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-5);
  }

  /* ---- Agents section ---- */

  .agents-section {
    border-block-start: 1px solid var(--color-border-1);
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    padding-block-start: var(--size-4);
  }

  .agents-list {
    display: flex;
    flex-direction: column;
  }

  .agent-row {
    align-items: center;
    color: inherit;
    display: flex;
    gap: var(--size-2);
    padding-block: var(--size-1-5);
    text-decoration: none;
  }

  .agent-row:not(:last-child) {
    border-block-end: 1px solid color-mix(in srgb, var(--color-border-1), transparent 50%);
  }

  .agent-row:hover {
    background-color: color-mix(in srgb, var(--color-text), transparent 96%);
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

  .agent-name {
    color: var(--color-text);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .agent-type-badge {
    background-color: color-mix(in srgb, var(--color-success), transparent 85%);
    border-radius: var(--radius-1);
    color: var(--color-success);
    flex-shrink: 0;
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-0);
    font-weight: var(--font-weight-5);
    letter-spacing: var(--font-letterspacing-1);
    padding: var(--size-0-5) var(--size-1);
    text-transform: uppercase;
  }

  /* ---- Signals section ---- */

  .signals-section {
    border-block-start: 1px solid var(--color-border-1);
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    padding-block-start: var(--size-4);
  }

  .section-label {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    margin: 0;
  }

  .signals-list {
    display: flex;
    flex-direction: column;
  }

  .signal-entry {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    padding: var(--size-2) 0;
  }

  .signal-entry:not(:last-child) {
    border-block-end: 1px solid color-mix(in srgb, var(--color-border-1), transparent 50%);
  }

  .signal-header {
    align-items: center;
    display: flex;
    gap: var(--size-2);
  }

  .signal-name {
    color: var(--color-text);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
  }

  .provider-badge {
    background-color: color-mix(in srgb, var(--color-info), transparent 85%);
    border-radius: var(--radius-1);
    color: var(--color-info);
    font-family: var(--font-family-monospace);
    font-size: 9px;
    font-weight: var(--font-weight-6);
    letter-spacing: var(--font-letterspacing-1);
    padding: var(--size-0-5) var(--size-1);
    text-transform: uppercase;
  }

  .signal-config {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-1);
  }

  .schema-fields {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
    padding-inline-start: var(--size-2);
  }

  .schema-row {
    align-items: baseline;
    display: flex;
    gap: var(--size-2);
  }

  .field-name {
    color: var(--color-text);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
  }

  .field-type {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-0);
  }

  .field-required {
    color: var(--color-warning);
    font-size: var(--font-size-0);
    font-weight: var(--font-weight-5);
  }

  .field-desc {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-0);
    font-style: italic;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
