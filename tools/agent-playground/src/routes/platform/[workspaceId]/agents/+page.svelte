<!--
  Agents page — full detail view for workspace-level agents.

  Each agent card shows identity, config, environment, and usage in a single
  always-expanded layout. Cards have hash-target IDs for sidebar navigation.

  @component
-->

<script lang="ts">
  import { deriveAgentJobUsage, type AgentStepRef } from "@atlas/config/agent-job-usage";
  import { deriveDataContracts, type DataContract } from "@atlas/config/data-contracts";
  import { deriveWorkspaceAgents, type WorkspaceAgent } from "@atlas/config/workspace-agents";
  import { Icons } from "@atlas/ui";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import AgentIoSchemas from "$lib/components/agent-io-schemas.svelte";
  import WorkspaceBreadcrumb from "$lib/components/workspace-breadcrumb.svelte";
  import {
    useIntegrationsPreflight,
    type IntegrationStatus,
  } from "$lib/queries/integrations-preflight";
  import { useWorkspaceConfig } from "$lib/queries/workspace-config";

  const workspaceId = $derived(page.params.workspaceId ?? null);
  const configQuery = useWorkspaceConfig(() => workspaceId);

  const workspaceAgents = $derived.by(() => {
    const data = configQuery.data;
    if (!data) return [];
    return deriveWorkspaceAgents(data.config);
  });

  const agentJobUsage = $derived.by(() => {
    const data = configQuery.data;
    if (!data) return new Map<string, AgentStepRef[]>();
    return deriveAgentJobUsage(data.config);
  });

  /** Data contracts lookup: "jobId:stepId" -> DataContract */
  const contractsByStep = $derived.by((): Map<string, DataContract> => {
    const data = configQuery.data;
    if (!data) return new Map();
    const contracts = deriveDataContracts(data.config);
    const map = new Map<string, DataContract>();
    for (const c of contracts) {
      map.set(`${c.jobId}:${c.fromStepId}`, c);
    }
    return map;
  });

  function navigateToStep(jobId: string, stepId: string) {
    if (!workspaceId) return;
    goto(`/platform/${workspaceId}/agent/${jobId}:${stepId}`);
  }

  function typeBadge(agent: WorkspaceAgent): string {
    if (agent.type === "atlas" || agent.agent) {
      return agent.agent ? `BUILT-IN · ${agent.agent}` : "BUILT-IN";
    }
    if (agent.type === "llm") return "CUSTOM";
    return agent.type;
  }

  function configStrip(agent: WorkspaceAgent): string | undefined {
    if (agent.type !== "llm" || !agent.provider || !agent.model) return undefined;
    let strip = `${agent.provider} / ${agent.model}`;
    if (agent.temperature !== undefined) strip += ` · temp ${agent.temperature}`;
    return strip;
  }

  /** Build config property rows for an LLM agent's detail tier. */
  function llmConfigRows(agent: WorkspaceAgent): Array<{ label: string; value: string }> {
    const rows: Array<{ label: string; value: string }> = [];
    if (agent.provider) rows.push({ label: "Provider", value: agent.provider });
    if (agent.model) rows.push({ label: "Model", value: agent.model });
    if (agent.temperature !== undefined)
      rows.push({ label: "Temperature", value: String(agent.temperature) });
    if (agent.maxTokens !== undefined)
      rows.push({ label: "Max Tokens", value: String(agent.maxTokens) });
    if (agent.toolChoice) rows.push({ label: "Tool Choice", value: agent.toolChoice });
    if (agent.timeout) rows.push({ label: "Timeout", value: agent.timeout });
    if (agent.maxRetries !== undefined)
      rows.push({ label: "Max Retries", value: String(agent.maxRetries) });
    if (agent.providerOptions && Object.keys(agent.providerOptions).length > 0) {
      rows.push({ label: "Provider Options", value: JSON.stringify(agent.providerOptions) });
    }
    return rows;
  }

  // ---------------------------------------------------------------------------
  // Preflight health status
  // ---------------------------------------------------------------------------

  const preflightQuery = useIntegrationsPreflight(() => workspaceId);

  /** Provider -> status lookup from preflight data. */
  const providerStatus = $derived.by((): Map<string, IntegrationStatus> => {
    const map = new Map<string, IntegrationStatus>();
    for (const entry of preflightQuery.data?.integrations ?? []) {
      map.set(entry.provider, entry.status);
    }
    return map;
  });

  /**
   * Extract provider names from agent env vars (link refs only).
   */
  function agentProviders(agent: WorkspaceAgent): string[] {
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
    return providers;
  }

  /**
   * Determine the health status for an agent based on its providers.
   * Returns the worst status across all providers, or null if no link credentials.
   */
  function agentHealth(agent: WorkspaceAgent): IntegrationStatus | null {
    const providers = agentProviders(agent);
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

  function healthTitle(status: IntegrationStatus): string {
    switch (status) {
      case "connected":
        return "Credentials connected";
      case "degraded":
        return "Credentials degraded";
      case "disconnected":
        return "Credentials not connected";
    }
  }

  interface EnvVarRow {
    key: string;
    source: "link" | "literal";
    provider: string | null;
    status: IntegrationStatus | null;
  }

  /** Derive env var rows with resolution source and status. */
  function envVarRows(agent: WorkspaceAgent): EnvVarRow[] {
    const rows: EnvVarRow[] = [];
    for (const [key, value] of Object.entries(agent.env)) {
      if (
        typeof value === "object" &&
        value !== null &&
        "from" in value &&
        (value as Record<string, unknown>).from === "link"
      ) {
        const provider =
          (value as Record<string, unknown>).provider ?? (value as Record<string, unknown>).id;
        const providerStr = typeof provider === "string" ? provider : null;
        const status = providerStr ? (providerStatus.get(providerStr) ?? "disconnected") : null;
        rows.push({ key, source: "link", provider: providerStr, status });
      } else {
        rows.push({ key, source: "literal", provider: null, status: null });
      }
    }
    return rows;
  }
</script>

<div class="agents-page">
  {#if workspaceId}
    <WorkspaceBreadcrumb {workspaceId} />
  {/if}

  <header class="page-header">
    <h1>Agents</h1>
    <p class="page-subtitle">
      Agents handle individual steps in your workspace jobs. Each one runs a specific task.
    </p>
  </header>

  {#if configQuery.isLoading}
    <div class="empty-state">
      <p>Loading agents...</p>
    </div>
  {:else if configQuery.isError}
    <div class="empty-state">
      <p>Failed to load workspace config</p>
    </div>
  {:else if workspaceAgents.length === 0}
    <div class="empty-state">
      <p>No agents configured</p>
      <span class="empty-hint">Add agents to your workspace.yml to see them here</span>
    </div>
  {:else}
    <div class="agent-list">
      {#each workspaceAgents as agent (agent.id)}
        {@const usage = agentJobUsage.get(agent.id) ?? []}
        {@const health = agentHealth(agent)}
        {@const envRows = envVarRows(agent)}
        <div class="agent-card" id="agent-{agent.id}">
          <div class="card-header">
            {#if health !== null}
              <span
                class="health-dot"
                class:connected={health === "connected"}
                class:degraded={health === "degraded"}
                class:disconnected={health === "disconnected"}
                title={healthTitle(health)}
              ></span>
            {/if}
            <h2 class="agent-name">{agent.name}</h2>
            <span class="type-badge" class:custom={agent.type === "llm"}>{typeBadge(agent)}</span>
            <button
              class="edit-yaml-btn"
              title="Edit configuration"
              aria-label="Edit configuration"
              onclick={() => goto(`/platform/${workspaceId}/edit?path=agents.${agent.id}`)}
            >
              <Icons.Pencil />
              Edit
            </button>
          </div>

          {#if agent.description}
            <p class="agent-description">{agent.description}</p>
          {/if}

          {#if configStrip(agent)}
            <p class="config-strip">{configStrip(agent)}</p>
          {/if}

          {#if agent.tools && agent.tools.length > 0}
            <div class="tool-pills">
              {#each agent.tools as tool (tool)}
                <span class="tool-pill">{tool}</span>
              {/each}
            </div>
          {/if}

          <div class="detail-tier-inner">
            {#if agent.prompt}
              <div class="detail-section">
                <h3 class="detail-label">Prompt</h3>
                <pre class="prompt-block">{agent.prompt}</pre>
              </div>
            {/if}

            {#if agent.type === "llm"}
              {@const rows = llmConfigRows(agent)}
              {#if rows.length > 0}
                <div class="detail-section">
                  <h3 class="detail-label">Configuration</h3>
                  <table class="config-table">
                    <tbody>
                      {#each rows as row (row.label)}
                        <tr>
                          <td class="config-key">{row.label}</td>
                          <td class="config-value">{row.value}</td>
                        </tr>
                      {/each}
                    </tbody>
                  </table>
                </div>
              {/if}
            {/if}

            {#if agent.type === "atlas" && agent.agent}
              <AgentIoSchemas agentId={agent.agent} />
            {/if}

            {#if envRows.length > 0}
              <div class="detail-section">
                <h3 class="detail-label">Environment</h3>
                <table class="env-table">
                  <tbody>
                    {#each envRows as row (row.key)}
                      <tr>
                        <td class="env-key"><code>{row.key}</code></td>
                        <td class="env-source">
                          {#if row.source === "link" && row.provider}
                            {row.provider}
                          {:else if row.source === "link"}
                            linked
                          {:else}
                            static
                          {/if}
                        </td>
                        <td class="env-status">
                          {#if row.status !== null}
                            <span
                              class="env-status-dot"
                              class:connected={row.status === "connected"}
                              class:degraded={row.status === "degraded"}
                              class:disconnected={row.status === "disconnected"}
                              title={healthTitle(row.status)}
                            ></span>
                          {/if}
                        </td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            {/if}

            <div class="detail-section">
              <h3 class="detail-label">Used in jobs</h3>
              {#if usage.length === 0}
                <p class="used-in-empty">Not referenced in any job step</p>
              {:else}
                <div class="used-in-list">
                  {#each usage as ref (ref.jobId + ":" + ref.stepId)}
                    {@const contract = contractsByStep.get(`${ref.jobId}:${ref.stepId}`)}
                    <div class="used-in-entry">
                      <button
                        class="used-in-step"
                        onclick={() => navigateToStep(ref.jobId, ref.stepId)}
                      >
                        {ref.stepName}
                      </button>
                      <span class="used-in-job">{ref.jobId}</span>
                      {#if contract}
                        <span class="used-in-doctype">{contract.documentType}</span>
                      {/if}
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .agents-page {
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

  .agent-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
  }

  .agent-card {
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

  .health-dot {
    background-color: color-mix(in srgb, var(--color-text), transparent 70%);
    block-size: 7px;
    border-radius: 50%;
    flex-shrink: 0;
    inline-size: 7px;
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
    font-size: var(--font-size-4);
    font-weight: var(--font-weight-6);
  }

  .type-badge {
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

  .type-badge.custom {
    background-color: color-mix(in srgb, var(--color-info), transparent 85%);
    color: var(--color-info);
  }

  .edit-yaml-btn {
    align-items: center;
    background: none;
    border: none;
    color: color-mix(in srgb, var(--color-text), transparent 45%);
    cursor: pointer;
    display: flex;
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    gap: var(--size-1-5);
    margin-inline-start: auto;
    padding: var(--size-0-5) var(--size-1);
  }

  .edit-yaml-btn:hover {
    color: var(--color-text);
  }

  .agent-description {
    color: color-mix(in srgb, var(--color-text), transparent 20%);
    font-size: var(--font-size-2);
    line-height: 1.5;
    max-inline-size: 60ch;
  }

  .config-strip {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-1);
  }

  .tool-pills {
    display: flex;
    flex-wrap: wrap;
    gap: var(--size-1);
  }

  .tool-pill {
    background-color: var(--color-surface-2);
    border-radius: var(--radius-1);
    color: var(--color-text);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-1);
    padding: var(--size-0-5) var(--size-2);
  }

  .detail-tier-inner {
    border-block-start: 1px solid var(--color-border-1);
    display: flex;
    flex-direction: column;
    gap: var(--size-4);
    padding-block-start: var(--size-4);
  }

  .detail-section {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .detail-label {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
  }

  .prompt-block {
    background-color: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    color: var(--color-text);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-1);
    line-height: 1.6;
    max-block-size: 300px;
    overflow-y: auto;
    padding: var(--size-3);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .config-table {
    border-collapse: collapse;
    font-size: var(--font-size-1);
    inline-size: 100%;
    max-inline-size: 500px;
  }

  .config-table tr {
    border-block-end: 1px solid var(--color-border-1);
  }

  .config-table tr:last-child {
    border-block-end: none;
  }

  .config-key {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-weight: var(--font-weight-5);
    padding: var(--size-1-5) var(--size-3) var(--size-1-5) 0;
    vertical-align: top;
    white-space: nowrap;
  }

  .config-value {
    color: var(--color-text);
    font-family: var(--font-family-monospace);
    padding: var(--size-1-5) 0;
    word-break: break-all;
  }

  .env-table {
    border-collapse: collapse;
    font-size: var(--font-size-1);
    inline-size: 100%;
    max-inline-size: 500px;
  }

  .env-table tr {
    border-block-end: 1px solid color-mix(in srgb, var(--color-border-1), transparent 50%);
  }

  .env-table tr:last-child {
    border-block-end: none;
  }

  .env-key {
    padding: var(--size-1-5) var(--size-3) var(--size-1-5) 0;
    vertical-align: baseline;
  }

  .env-key code {
    color: var(--color-text);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
  }

  .env-source {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-1);
    padding: var(--size-1-5) var(--size-2);
    vertical-align: baseline;
  }

  .env-status {
    padding: var(--size-1-5) 0;
    vertical-align: baseline;
  }

  .env-status-dot {
    background-color: color-mix(in srgb, var(--color-text), transparent 70%);
    block-size: 6px;
    border-radius: 50%;
    display: inline-block;
    inline-size: 6px;
  }

  .env-status-dot.connected {
    background-color: var(--color-success);
  }

  .env-status-dot.degraded {
    background-color: var(--color-warning);
  }

  .env-status-dot.disconnected {
    background-color: var(--color-error);
  }

  .used-in-empty {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-2);
    font-style: italic;
  }

  .used-in-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .used-in-entry {
    align-items: baseline;
    display: flex;
    gap: var(--size-2);
  }

  .used-in-step {
    background: none;
    border: none;
    color: var(--color-info);
    cursor: pointer;
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    padding: 0;
    text-align: start;
  }

  .used-in-step:hover {
    text-decoration: underline;
  }

  .used-in-job {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-1);
  }

  .used-in-doctype {
    background-color: var(--color-surface-2);
    border-radius: var(--radius-1);
    color: var(--color-text);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-0);
    font-weight: var(--font-weight-5);
    padding: var(--size-0-5) var(--size-1);
  }
</style>
