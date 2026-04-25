<!--
  Command center layout for testing a single bundled agent.

  Three-zone layout:
  - Main panel: agent header, prompt input with examples, run output stack
  - Reference sidebar: credential preflight, I/O schemas

  Contains the full execution flow: prompt input (textarea or structured form),
  artifact upload, execute/cancel, and run history stack
  with sessionStorage persistence.

  @component
  @param {AgentMetadata} agent - The agent to test
  @param {AgentPreflightCredential[]} credentials - Credential preflight status
  @param {() => void} onBack - Navigate back to catalog
  @param {(provider: string) => void} onOAuthConnect - Trigger OAuth flow
  @param {(provider: string) => void} onApiKeyConnect - Trigger API key / app install flow
-->

<script lang="ts">
  import { Button } from "@atlas/ui";
  import { parseSSEEvents } from "@atlas/utils/sse";
  import { getArtifactHint } from "$lib/artifact-hints.ts";
  import { getClient } from "$lib/client.ts";
  import AgentReferencePanel from "$lib/components/agents/agent-reference-panel.svelte";
  import ArtifactUpload from "$lib/components/shared/artifact-upload.svelte";
  import OperationForm from "$lib/components/shared/operation-form.svelte";
  import RunCard from "$lib/components/workspace/run-card.svelte";
  import * as promptHistory from "$lib/prompt-history.ts";
  import type { AgentMetadata, AgentPreflightCredential } from "$lib/queries";
  import { loadRuns, saveRuns } from "$lib/run-history.ts";
  import type { RunRecord } from "$lib/run-history.ts";
  import { SSEEventSchema, type SSEEvent } from "$lib/sse-types.ts";
  import InlineBadge from "$lib/components/shared/inline-badge.svelte";
  import type { ExecutionStatus } from "$lib/types/execution-status.ts";

  type Props = {
    agent: AgentMetadata;
    credentials: AgentPreflightCredential[];
    onBack: () => void;
    onOAuthConnect: (provider: string) => void;
    onApiKeyConnect: (provider: string) => void;
  };

  let { agent, credentials, onBack, onOAuthConnect, onApiKeyConnect }: Props = $props();

  let input = $state("");
  let manualOverrides = $state<Record<string, string>>({});
  let runs = $state<RunRecord[]>(loadRuns(agent.id));
  let execution = $state<ExecutionStatus>({ state: "idle" });
  let artifactId = $state<string | undefined>(undefined);
  let fileContent = $state<string | undefined>(undefined);
  let artifactUploadRef = $state<ArtifactUpload | undefined>(undefined);
  /** Whether the user is actively cycling through prompt history. */
  let inHistoryMode = $state(false);
  /** Stashed draft text saved when entering history mode. */
  let draftText = $state("");

  /** Next run ID, derived from the highest existing run number. */
  let nextRunId = $state(runs.length > 0 ? Math.max(...runs.map((r) => r.id)) + 1 : 1);

  // Scrub stale "running" runs from previous sessions on mount.
  runs = runs.map((r) =>
    r.status === "running"
      ? { ...r, status: "error" as const, events: [...r.events, { type: "error" as const, data: { error: "Interrupted" } }] }
      : r,
  );

  /** Green when no required credentials are disconnected. */
  const healthy = $derived(!credentials.some((c) => c.required && c.status === "disconnected"));

  /** Required credentials that are disconnected AND have no manual override. */
  const missingRequired = $derived(
    credentials.filter(
      (c) => c.required && c.status === "disconnected" && !manualOverrides[c.envKey]?.trim(),
    ),
  );

  /** Whether the selected agent uses structured input (discriminated union schema). */
  const isStructuredAgent = $derived(
    agent.inputSchema !== null &&
      typeof agent.inputSchema === "object" &&
      "oneOf" in (agent.inputSchema ?? {}),
  );

  /** Artifact input hint for the agent, if it requires file uploads. */
  const artifactHint = $derived(getArtifactHint(agent.id));

  /** Whether a file has been provided (either as artifact or inline content). */
  const hasFile = $derived(artifactId !== undefined || fileContent !== undefined);

  const canExecute = $derived(
    input.trim().length > 0 &&
      execution.state !== "running" &&
      (!artifactHint?.required || hasFile) &&
      missingRequired.length === 0,
  );

  function handleExampleClick(example: string) {
    input = example;
  }

  /**
   * Handle arrow-key prompt history navigation in the textarea.
   * Up/Down only activate when cursor is at position 0 with no selection.
   * Escape restores draft and exits history mode.
   */
  function handleHistoryKeydown(e: KeyboardEvent & { currentTarget: HTMLTextAreaElement }) {
    if (e.key === "Escape" && inHistoryMode) {
      e.preventDefault();
      input = draftText;
      inHistoryMode = false;
      promptHistory.reset();
      return;
    }

    if (e.key === "ArrowUp") {
      // Only trigger at line 0, col 0, no selection
      if (e.currentTarget.selectionStart !== 0 || e.currentTarget.selectionEnd !== 0) return;

      e.preventDefault();
      if (!inHistoryMode) {
        draftText = input;
        inHistoryMode = true;
      }
      const entry = promptHistory.cycle(agent.id, "prev");
      if (entry !== null) {
        input = entry;
      }
      return;
    }

    if (e.key === "ArrowDown" && inHistoryMode) {
      e.preventDefault();
      const entry = promptHistory.cycle(agent.id, "next");
      if (entry !== null) {
        input = entry;
      } else {
        // Past newest — restore draft
        input = draftText;
        inHistoryMode = false;
      }
      return;
    }

    // Any other key exits history mode
    if (inHistoryMode && e.key.length === 1) {
      inHistoryMode = false;
      promptHistory.reset();
    }
  }

  /** Cancel the active SSE stream. Triggers server-side abort via stream close. */
  function cancel() {
    if (execution.state !== "running") return;
    execution.stream.cancel();
    execution = { state: "cancelled" };
  }

  /** Update a specific run record by ID. */
  function updateRunById(id: number, updater: (run: RunRecord) => RunRecord): void {
    runs = runs.map((r) => (r.id === id ? updater(r) : r));
  }

  function deriveStatus(run: RunRecord, wasCancelled: boolean): RunRecord["status"] {
    if (wasCancelled) return "cancelled";
    if (run.events.some((e) => e.type === "error")) return "error";
    return "success";
  }

  /**
   * Consume an SSE stream for a specific run, accumulating events into that run's record.
   * Captures runId so background completions always update the correct entry.
   */
  async function consumeSSEStream(body: ReadableStream<Uint8Array>, runId: number) {
    try {
      for await (const msg of parseSSEEvents(body)) {
        const parsed = SSEEventSchema.safeParse({ type: msg.event, data: msg.data });
        if (!parsed.success) continue;
        const event: SSEEvent = parsed.data;
        updateRunById(runId, (run) => {
          const updatedEvents = [...run.events, event];
          const updates: Partial<RunRecord> = { events: updatedEvents };
          if (event.type === "result") {
            updates.result = event.data;
          } else if (event.type === "trace") {
            updates.traces = [...run.traces, event.data];
          } else if (event.type === "done") {
            updates.stats = event.data;
          }
          return { ...run, ...updates };
        });
      }
    } catch {
      if (execution.state !== "cancelled") {
        updateRunById(runId, (run) => ({
          ...run,
          events: [...run.events, { type: "error", data: { error: "Connection lost" } }],
        }));
      }
    } finally {
      const wasCancelled = execution.state === "cancelled";
      updateRunById(runId, (run) => ({ ...run, status: deriveStatus(run, wasCancelled) }));
      if (!wasCancelled) {
        execution = { state: "complete" };
      }
      saveRuns(agent.id, runs);
    }
  }

  /**
   * Build the final input string.
   * - artifact-ref mode: injects artifact ID via ## Signal Data block
   * - inline-content mode: appends file text directly into the prompt
   */
  function buildInput(): string {
    const prompt = input.trim();

    if (fileContent) {
      return `${prompt}\n\n---\n\n${fileContent}`;
    }

    if (artifactId) {
      const signalData = JSON.stringify({ artifact_id: artifactId }, null, 2);
      return `${prompt}\n\n## Signal Data\n\n\`\`\`json\n${signalData}\n\`\`\``;
    }

    return prompt;
  }

  /** Execute the bundled agent, creating a new run record in the history stack. */
  async function execute() {
    if (!input.trim()) return;

    if (execution.state === "running") {
      execution.stream.cancel();
    }

    const runId = nextRunId++;
    const newRun: RunRecord = {
      id: runId,
      prompt: input.trim(),
      agentId: agent.id,
      events: [],
      result: null,
      traces: [],
      stats: null,
      status: "running",
      startedAt: Date.now(),
    };

    runs = [newRun, ...runs];
    promptHistory.push(agent.id, input.trim());
    promptHistory.reset();
    inHistoryMode = false;

    try {
      const res = await getClient().api.execute.$post({
        json: {
          agentId: agent.id,
          input: buildInput(),
          env: Object.keys(manualOverrides).length > 0 ? manualOverrides : undefined,
        },
      });

      if (!res.ok) {
        const text = await res.text();
        updateRunById(runId, (run) => ({
          ...run,
          events: [{ type: "error", data: { error: `HTTP ${res.status}: ${text}` } }],
          status: "error",
        }));
        execution = { state: "error", message: `HTTP ${res.status}: ${text}` };
        saveRuns(agent.id, runs);
        return;
      }
      if (!res.body) {
        updateRunById(runId, (run) => ({
          ...run,
          events: [{ type: "error", data: { error: "No response body" } }],
          status: "error",
        }));
        execution = { state: "error", message: "No response body" };
        saveRuns(agent.id, runs);
        return;
      }

      execution = { state: "running", stream: res.body };
      consumeSSEStream(res.body, runId);
    } catch {
      if (execution.state !== "cancelled") {
        updateRunById(runId, (run) => ({
          ...run,
          events: [...run.events, { type: "error", data: { error: "Connection lost" } }],
          status: "error",
        }));
        execution = { state: "error", message: "Connection lost" };
      }
      saveRuns(agent.id, runs);
    }
  }

  /** Re-run: populate the prompt textarea and execute immediately. */
  function handleRerun(prompt: string) {
    input = prompt;
    execute();
  }
</script>

<div class="shell">
  <div class="main-panel">
    <header class="agent-header">
      <button class="back-link" onclick={onBack} type="button">&larr; All agents</button>

      <div class="identity-row">
        <span class="health-dot" class:healthy class:unhealthy={!healthy}></span>
        <h1 class="agent-name">{agent.displayName}</h1>
        <span class="version">{agent.version}</span>
        <InlineBadge variant={agent.source === "user" ? "info" : "success"}>
          {agent.source === "user" ? "USER" : "BUILT-IN"}
        </InlineBadge>
      </div>
    </header>

    <div class="workspace">
      {#if runs.length === 0}
        <div class="agent-intro">
          {#if agent.summary}
            <p class="agent-summary">{agent.summary}</p>
          {/if}
          {#if agent.constraints}
            <p class="agent-constraints">{agent.constraints}</p>
          {/if}
        </div>
      {/if}

      {#if isStructuredAgent && agent.inputSchema}
        <OperationForm
          schema={agent.inputSchema as Record<string, unknown>}
          onInput={(v) => {
            input = v;
          }}
        />
      {:else}
        <div class="input-section">
          {#if runs.length === 0 && agent.examples.length > 0}
            <div class="example-cards">
              <span class="examples-heading">Try it</span>
              {#each agent.examples.slice(0, 3) as example, i (i)}
                <button
                  class="example-card"
                  type="button"
                  onclick={() => handleExampleClick(example)}
                >
                  {example}
                </button>
              {/each}
            </div>
          {/if}

          {#if artifactHint}
            <ArtifactUpload
              bind:this={artifactUploadRef}
              hint={artifactHint}
              onResult={(result) => {
                artifactId = undefined;
                fileContent = undefined;
                if (result?.type === "artifact") {
                  artifactId = result.artifactId;
                } else if (result?.type === "content") {
                  fileContent = result.content;
                }
              }}
            />
          {/if}

          <textarea
            id="prompt-input"
            class="prompt-textarea"
            bind:value={input}
            placeholder="Enter your prompt..."
            rows="3"
            onkeydown={(e) => {
              handleHistoryKeydown(e);
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canExecute) {
                execute();
              }
            }}
          ></textarea>
        </div>
      {/if}

      <div class="action-bar">
        {#if missingRequired.length > 0}
          <span class="missing-hint">
            Missing: {missingRequired.map((c) => c.envKey).join(", ")}
          </span>
        {/if}

        <div class="action-end">
          {#if execution.state === "running"}
            <Button variant="secondary" onclick={cancel}>Cancel</Button>
          {:else}
            <kbd class="shortcut-hint">&#8984;&#9166;</kbd>
            <Button variant="primary" disabled={!canExecute} onclick={execute}>Execute</Button>
          {/if}
        </div>
      </div>

      {#if runs.length > 0}
        <div class="output-section">
          <div class="run-stack">
            {#each runs as run, i (run.id)}
              <RunCard {run} expanded={i === 0} onRerun={handleRerun} />
            {/each}
          </div>
        </div>
      {/if}
    </div>
  </div>

  <AgentReferencePanel
    {agent}
    {credentials}
    bind:manualOverrides
    {onOAuthConnect}
    {onApiKeyConnect}
  />
</div>

<style>
  .shell {
    block-size: 100%;
    display: flex;
    flex-direction: row;
    overflow: hidden;
  }

  /* ── Main panel ── */

  .main-panel {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-inline-size: 0;
    overflow: hidden;
  }

  .agent-header {
    border-block-end: 1px solid var(--color-border-1);
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    gap: var(--size-2);
    padding-block: var(--size-4);
    padding-inline: var(--size-6);
  }

  .back-link {
    background: none;
    border: none;
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    cursor: pointer;
    font-size: var(--font-size-2);
    padding: 0;
    text-align: start;
    inline-size: fit-content;
  }

  .back-link:hover {
    color: var(--color-text);
  }

  .identity-row {
    align-items: center;
    display: flex;
    gap: var(--size-3);
  }

  .agent-name {
    font-size: var(--font-size-6);
    font-weight: var(--font-weight-6);
  }

  .version {
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-2);
  }

  .health-dot {
    block-size: 8px;
    border-radius: 50%;
    flex-shrink: 0;
    inline-size: 8px;
  }

  .health-dot.healthy {
    background-color: var(--color-success);
  }

  .health-dot.unhealthy {
    background-color: var(--color-error);
  }

  /* ── Workspace (input + output) ── */

  .workspace {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--size-4);
    min-block-size: 0;
    overflow-y: auto;
    padding-block: var(--size-5);
    padding-inline: var(--size-6);
  }

  /* ── Agent intro (empty state) ── */

  .agent-intro {
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
    max-inline-size: 64ch;
  }

  .agent-summary {
    color: color-mix(in srgb, var(--color-text), transparent 20%);
    font-size: var(--font-size-3);
    line-height: var(--font-lineheight-3);
    margin: 0;
  }

  .agent-constraints {
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    font-size: var(--font-size-2);
    font-style: italic;
    line-height: var(--font-lineheight-3);
    margin: 0;
  }

  /* ── Input section ── */

  .input-section {
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
  }

  .example-cards {
    display: flex;
    flex-direction: column;
    gap: var(--size-1-5);
  }

  .examples-heading {
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    letter-spacing: var(--font-letterspacing-2);
    text-transform: uppercase;
  }

  .example-card {
    background-color: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    color: color-mix(in srgb, var(--color-text), transparent 20%);
    cursor: pointer;
    font-family: var(--font-family-sans);
    font-size: var(--font-size-2);
    line-height: var(--font-lineheight-3);
    padding: var(--size-2-5) var(--size-3);
    text-align: start;
    transition:
      border-color 150ms ease,
      background-color 150ms ease;
  }

  .example-card:hover {
    background-color: color-mix(in srgb, var(--color-surface-2), var(--color-text) 4%);
    border-color: color-mix(in srgb, var(--color-text), transparent 60%);
  }

  .prompt-textarea {
    background-color: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    color: var(--color-text);
    font-family: var(--font-family-sans);
    font-size: var(--font-size-3);
    inline-size: 100%;
    line-height: var(--font-lineheight-3);
    padding: var(--size-2-5);
    resize: vertical;
  }

  .prompt-textarea:focus {
    border-color: color-mix(in srgb, var(--color-text), transparent 60%);
    outline: none;
  }

  /* ── Action bar ── */

  .action-bar {
    align-items: center;
    display: flex;
    gap: var(--size-3);
  }

  .action-end {
    align-items: center;
    display: flex;
    gap: var(--size-2);
    margin-inline-start: auto;
  }

  .shortcut-hint {
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-1);
  }

  .missing-hint {
    color: var(--color-error);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
  }

  /* ── Output ── */

  .output-section {
    display: flex;
    flex: 1;
    flex-direction: column;
  }

  .run-stack {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }
</style>
