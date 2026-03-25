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
  import { Icons, Button } from "@atlas/ui";
  import { getArtifactHint } from "$lib/artifact-hints.ts";
  import { getClient } from "$lib/client.ts";
  import ArtifactUpload from "$lib/components/artifact-upload.svelte";
  import CredentialPanel from "$lib/components/credential-panel.svelte";
  import OperationForm from "$lib/components/operation-form.svelte";
  import RunCard from "$lib/components/run-card.svelte";
  import SchemaPropertyStack from "$lib/components/schema-property-stack.svelte";
  import * as promptHistory from "$lib/prompt-history.ts";
  import type { AgentPreflightCredential } from "$lib/queries/agent-preflight.ts";
  import type { AgentMetadata } from "$lib/queries/agents-list.ts";
  import { loadRuns, saveRuns } from "$lib/run-history.ts";
  import type { RunRecord } from "$lib/run-history.ts";
  import type { SSEEvent } from "$lib/sse-types.ts";

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
  let inputSchemaOpen = $state(false);
  let outputSchemaOpen = $state(false);
  let runs = $state<RunRecord[]>(loadRuns(agent.id));
  let executing = $state(false);
  let cancelled = $state(false);
  let activeReader = $state<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  let artifactId = $state<string | undefined>(undefined);
  let fileContent = $state<string | undefined>(undefined);
  let artifactUploadRef = $state<ArtifactUpload | undefined>(undefined);
  /** Whether the user is actively cycling through prompt history. */
  let inHistoryMode = $state(false);
  /** Stashed draft text saved when entering history mode. */
  let draftText = $state("");

  /** Next run ID, derived from the highest existing run number. */
  let nextRunId = $state(runs.length > 0 ? Math.max(...runs.map((r) => r.id)) + 1 : 1);

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
      !executing &&
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
    if (!activeReader) return;
    cancelled = true;
    activeReader.cancel();
    activeReader = null;
  }

  /**
   * Update the active (first) run record in the runs array.
   * Triggers reactivity by replacing the array.
   */
  function updateActiveRun(updater: (run: RunRecord) => RunRecord): void {
    const active = runs[0];
    if (!active) return;
    runs = [updater(active), ...runs.slice(1)];
  }

  /**
   * Derive final status from the events accumulated in a run.
   * Called when the stream ends or errors.
   */
  function deriveStatus(run: RunRecord, wasCancelled: boolean): RunRecord["status"] {
    if (wasCancelled) return "cancelled";
    if (run.events.some((e) => e.type === "error")) return "error";
    return "success";
  }

  /**
   * Parse SSE text stream into typed events, accumulating into the active run record.
   * Handles `event:` / `data:` line protocol with `\n\n` delimiters.
   */
  function parseSSEStream(body: ReadableStream<Uint8Array>) {
    const reader = body.getReader();
    activeReader = reader;
    const decoder = new TextDecoder();
    let buffer = "";

    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          const segments = buffer.split("\n\n");
          buffer = segments.pop() ?? "";

          for (const segment of segments) {
            const lines = segment.split("\n");
            let eventType = "";
            let eventData = "";

            for (const line of lines) {
              if (line.startsWith("event: ")) {
                eventType = line.slice(7).trim();
              } else if (line.startsWith("data: ")) {
                eventData = line.slice(6);
              }
            }

            if (eventType && eventData) {
              try {
                const parsed = JSON.parse(eventData);
                const event = { type: eventType, data: parsed } as SSEEvent;
                updateActiveRun((run) => {
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
              } catch {
                console.warn("Failed to parse SSE data:", eventData);
              }
            }
          }
        }
      } catch {
        if (!cancelled) {
          const errorEvent: SSEEvent = { type: "error", data: { error: "Connection lost" } };
          updateActiveRun((run) => ({ ...run, events: [...run.events, errorEvent] }));
        }
      } finally {
        activeReader = null;
        executing = false;
        updateActiveRun((run) => ({ ...run, status: deriveStatus(run, cancelled) }));
        saveRuns(agent.id, runs);
      }
    })();
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

    if (activeReader) {
      activeReader.cancel();
      activeReader = null;
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
    executing = true;
    cancelled = false;

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
        updateActiveRun((run) => ({
          ...run,
          events: [{ type: "error", data: { error: `HTTP ${res.status}: ${text}` } }],
          status: "error",
        }));
        executing = false;
        saveRuns(agent.id, runs);
        return;
      }
      if (!res.body) {
        updateActiveRun((run) => ({
          ...run,
          events: [{ type: "error", data: { error: "No response body" } }],
          status: "error",
        }));
        executing = false;
        saveRuns(agent.id, runs);
        return;
      }

      parseSSEStream(res.body);
    } catch {
      if (!cancelled) {
        updateActiveRun((run) => ({
          ...run,
          events: [...run.events, { type: "error", data: { error: "Connection lost" } }],
          status: "error",
        }));
      }
      executing = false;
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
        <span class="type-badge">BUILT-IN</span>
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
              {#each agent.examples.slice(0, 3) as example (example)}
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
          {#if executing}
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

  <aside class="reference-panel">
    <div class="explainer">
      <p class="explainer-text">
        Built-in agents ship with Friday — tested, versioned, and ready to use.
        They run in a sandboxed environment with their own tool access and credentials.
        You can't modify their behavior, but you can test them here with real inputs
        to verify they work as expected.
      </p>
    </div>

    {#if agent.summary}
      <div class="sidebar-section">
        <span class="section-label">Summary</span>
        <p class="sidebar-description">{agent.summary}</p>
      </div>
    {/if}

    {#if agent.constraints}
      <div class="sidebar-section">
        <span class="section-label">Constraints</span>
        <p class="sidebar-constraints">{agent.constraints}</p>
      </div>
    {/if}

    {#if agent.inputSchema}
      <div class="sidebar-section">
        <button class="schema-toggle" type="button" onclick={() => (inputSchemaOpen = !inputSchemaOpen)}>
          <span class="toggle-icon" class:open={inputSchemaOpen}>
            <Icons.TriangleRight />
          </span>
          <span class="section-label">Input Schema</span>
        </button>
        {#if inputSchemaOpen}
          <div class="schema-body">
            <SchemaPropertyStack schema={agent.inputSchema as object} />
          </div>
        {/if}
      </div>
    {/if}

    {#if agent.outputSchema}
      <div class="sidebar-section">
        <button class="schema-toggle" type="button" onclick={() => (outputSchemaOpen = !outputSchemaOpen)}>
          <span class="toggle-icon" class:open={outputSchemaOpen}>
            <Icons.TriangleRight />
          </span>
          <span class="section-label">Output Schema</span>
        </button>
        {#if outputSchemaOpen}
          <div class="schema-body">
            <SchemaPropertyStack schema={agent.outputSchema as object} />
          </div>
        {/if}
      </div>
    {/if}

    {#if credentials.length > 0}
      <CredentialPanel
        {credentials}
        bind:manualOverrides
        onconnect={onOAuthConnect}
        onapikey={onApiKeyConnect}
      />
    {/if}
  </aside>
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
    color: color-mix(in srgb, var(--color-text), transparent 40%);
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
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-2);
  }

  .type-badge {
    background-color: color-mix(in srgb, var(--color-text), transparent 90%);
    border-radius: var(--radius-1);
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-0);
    font-weight: var(--font-weight-5);
    letter-spacing: var(--font-letterspacing-2);
    padding-block: var(--size-0-5);
    padding-inline: var(--size-1-5);
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

  /* ── Sidebar sections ── */

  .explainer {
    border-block-end: 1px solid var(--color-border-1);
    padding-block-end: var(--size-4);
  }

  .explainer-text {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-1);
    line-height: var(--font-lineheight-3);
    margin: 0;
  }

  .sidebar-section {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .section-label {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    letter-spacing: var(--font-letterspacing-2);
    text-transform: uppercase;
  }

  .sidebar-description {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-size: var(--font-size-1);
    line-height: var(--font-lineheight-3);
    margin: 0;
  }

  .sidebar-constraints {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-1);
    font-style: italic;
    line-height: var(--font-lineheight-3);
    margin: 0;
  }

  .schema-toggle {
    align-items: center;
    background: none;
    border: none;
    color: var(--color-text);
    cursor: pointer;
    display: flex;
    gap: var(--size-1);
    padding: 0;
  }

  .schema-toggle:hover .section-label {
    color: color-mix(in srgb, var(--color-text), transparent 20%);
  }

  .toggle-icon {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    display: inline-flex;
    transition: transform 150ms ease;
  }

  .toggle-icon :global(svg) {
    block-size: 10px;
    inline-size: 10px;
  }

  .toggle-icon.open {
    transform: rotate(90deg);
  }

  .schema-body {
    padding-inline-start: var(--size-3);
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
    color: color-mix(in srgb, var(--color-text), transparent 50%);
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
    color: color-mix(in srgb, var(--color-text), transparent 40%);
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
    transition: border-color 150ms ease, background-color 150ms ease;
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
    color: color-mix(in srgb, var(--color-text), transparent 50%);
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


  /* ── Reference sidebar ── */

  .reference-panel {
    background-color: var(--color-surface-1);
    border-inline-start: 1px solid var(--color-border-1);
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    gap: var(--size-5);
    inline-size: 280px;
    overflow-y: auto;
    padding-block: var(--size-5);
    padding-inline: var(--size-4);
  }
</style>
