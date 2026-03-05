<script lang="ts">
  /**
   * Workspace Inspector page.
   *
   * Two entry points converging on the same visualization:
   * 1. Load — drop/paste a workspace.yml file to parse it
   * 2. Generate — type a prompt to run the builder pipeline via SSE
   *
   * Layout: full-width main content with a CSS grid column reserved for
   * a right-side execution drawer (future task). The secondary sidebar
   * is replaced by a horizontal top bar.
   */

  import type { Action, FSMDefinition } from "@atlas/fsm-engine";
  import { Button, Collapsible, IconSmall } from "@atlas/ui";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { getClient } from "$lib/client.ts";
  import ActionTrace from "$lib/components/action-trace.svelte";
  import ExecutionDrawerContent from "$lib/components/execution-drawer-content.svelte";
  import ExecutionPanel from "$lib/components/execution-panel.svelte";
  import ExecutionStream from "$lib/components/execution-stream.svelte";
  import FSMStateDiagram from "$lib/components/fsm-state-diagram.svelte";
  import ResultsAccumulator from "$lib/components/results-accumulator.svelte";
  import { provideExecutionState } from "$lib/execution-context.svelte.ts";
  import { z } from "zod";

  /** Stream-compatible event type shared with ExecutionStream. */
  type StreamEvent =
    | { type: "progress"; data: { type: string; [key: string]: unknown } }
    | { type: "log"; data: { level: string; message: string; [key: string]: unknown } }
    | {
        type: "trace";
        data: { spanId: string; name: string; durationMs: number; [key: string]: unknown };
      }
    | { type: "result"; data: unknown }
    | {
        type: "done";
        data: { durationMs: number; slug?: string; totalTokens?: number; stepCount?: number };
      }
    | { type: "error"; data: { error: string } };

  /** Workspace-specific SSE events (superset of stream events). */
  type SSEEvent = StreamEvent | { type: "artifact"; data: { name: string; content: string } };

  /** Signal config shape matching WorkspaceSignalConfig from @atlas/config. */
  interface SignalConfig {
    provider: string;
    description: string;
    title?: string;
    config?: Record<string, unknown>;
    schema?: Record<string, unknown>;
  }

  /** Agent config shape matching WorkspaceAgentConfig from @atlas/config. */
  interface AgentConfig {
    type: string;
    description: string;
    agent?: string;
    prompt?: string;
    config?: Record<string, unknown>;
  }

  /** MCP transport config. */
  interface MCPTransport {
    type: "stdio" | "http";
    command?: string;
    args?: string[];
    url?: string;
  }

  /** MCP server config matching MCPServerConfig from @atlas/agent-sdk. */
  interface MCPServer {
    transport: MCPTransport;
    tools?: { allow?: string[]; deny?: string[] };
    auth?: { type: string; token_env?: string };
  }

  /** Tools config matching ToolsConfig from @atlas/config. */
  interface ToolsData {
    mcp?: { client_config?: Record<string, unknown>; servers?: Record<string, MCPServer> };
  }

  /** Job spec matching JobSpecification from @atlas/config. */
  interface JobData {
    name?: string;
    description?: string;
    title?: string;
    triggers?: Array<{ signal: string; condition?: string }>;
    execution?: { strategy?: string; agents?: Array<string | { id: string }> };
    fsm?: FSMDefinition;
    config?: Record<string, unknown>;
  }

  /** Execution report shape from ExecutionPanel. */
  type ExecutionReport = {
    success: boolean;
    finalState: string;
    stateTransitions: Array<{ from: string; to: string; signal: string; timestamp: number }>;
    resultSnapshots: Record<string, Record<string, Record<string, unknown>>>;
    actionTrace: Array<{
      state: string;
      actionType: string;
      actionId?: string;
      input?: { task?: string; config?: Record<string, unknown> };
      status: "started" | "completed" | "failed";
      error?: string;
    }>;
    assertions: Array<{ check: string; passed: boolean; detail?: string }>;
    error?: string;
    durationMs: number;
  };

  /** Parsed workspace data available for inspector panels. */
  interface WorkspaceData {
    workspace: { name?: string; description?: string; [key: string]: unknown };
    signals: Record<string, SignalConfig>;
    agents: Record<string, AgentConfig>;
    jobs: Record<string, JobData>;
    tools: ToolsData;
    raw: string;
  }

  let prompt = $state("");
  let events = $state<SSEEvent[]>([]);
  let executing = $state(false);
  let cancelled = $state(false);
  let activeReader = $state<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  let parseError = $state<string | null>(null);
  let workspaceData = $state<WorkspaceData | null>(null);
  let dragging = $state(false);
  let executionReports = $state<ExecutionReport[]>([]);
  let executionStepIndex = $state(-1);

  /**
   * Tracks pipeline phase during workspace generation for progressive rendering.
   * Sections appear as their data becomes available.
   */
  type GenerationPhase = "idle" | "generating" | "blueprint" | "compiled" | "assembled";
  let generationPhase = $state<GenerationPhase>("idle");

  /** Whether the streaming log panel is expanded during generation. */
  let showLogs = $state(false);

  /** Provide shared ExecutionState context for the drawer and downstream components. */
  const execution = provideExecutionState();

  const canGenerate = $derived(prompt.trim().length > 0 && !executing);

  /** True when generation is actively streaming (phase beyond idle and stream running). */
  const isGenerating = $derived(generationPhase !== "idle" && executing);

  /** Events compatible with ExecutionStream (filters out workspace-only event types). */
  const streamEvents = $derived(events.filter((e): e is StreamEvent => e.type !== "artifact"));

  /** Extracted artifacts from SSE events, keyed by name. */
  const artifacts = $derived(
    events
      .filter((e): e is SSEEvent & { type: "artifact" } => e.type === "artifact")
      .reduce<Record<string, string>>((acc, e) => {
        acc[e.data.name] = e.data.content;
        return acc;
      }, {}),
  );

  /** Done event from stream completion, or null while running. */
  const doneEvent = $derived(
    events.find((e): e is SSEEvent & { type: "done" } => e.type === "done")?.data ?? null,
  );

  /** Entries from the signals record for iteration. */
  const signalEntries = $derived(workspaceData ? Object.entries(workspaceData.signals) : []);

  /** Currently expanded signal name (click-to-expand detail), or null. */
  let expandedSignal = $state<string | null>(null);

  /** Currently expanded agent name (click-to-expand detail), or null. */
  let expandedAgent = $state<string | null>(null);

  /** Entries from the agents record for iteration. */
  const agentEntries = $derived(workspaceData ? Object.entries(workspaceData.agents) : []);

  /** Workspace-level MCP server names for tool pills on agent cards. */
  const mcpServerNames = $derived.by(() => {
    if (!workspaceData?.tools?.mcp?.servers) return [];
    return Object.keys(workspaceData.tools.mcp.servers);
  });

  /** Jobs that have FSM definitions. */
  const fsmJobs = $derived.by(() => {
    if (!workspaceData) return [];
    return Object.entries(workspaceData.jobs)
      .filter(([, job]) => job.fsm)
      .map(([id, job]) => ({ id, job, fsm: job.fsm as FSMDefinition }));
  });

  /** All document types across all job FSMs, enriched with producing state. */
  const documentTypes = $derived.by(() => {
    if (!workspaceData) return [];
    const docs: Array<{
      jobId: string;
      docId: string;
      schema: Record<string, unknown>;
      producingState: string | null;
    }> = [];
    for (const [jobId, job] of Object.entries(workspaceData.jobs)) {
      const fsm = job.fsm;
      if (!fsm || !fsm.documentTypes) continue;

      // Build a map: document type name → producing state name
      const producers = new Map<string, string>();
      for (const [stateName, state] of Object.entries(fsm.states)) {
        for (const action of state.entry ?? []) {
          if ("outputType" in action && typeof action.outputType === "string") {
            producers.set(action.outputType, stateName);
          } else if ("outputTo" in action && typeof action.outputTo === "string") {
            // Find the document type from the state's documents list
            const doc = state.documents?.find((d) => d.id === action.outputTo);
            if (doc) producers.set(doc.type, stateName);
          }
        }
      }

      for (const [docId, schema] of Object.entries(fsm.documentTypes)) {
        docs.push({ jobId, docId, schema, producingState: producers.get(docId) ?? null });
      }
    }
    return docs;
  });

  /** MCP server entries from tools config. */
  const mcpServers = $derived.by(() => {
    if (!workspaceData?.tools?.mcp?.servers) return [];
    return Object.entries(workspaceData.tools.mcp.servers);
  });

  /** State order from execution report for stepper components. */
  const stateOrder = $derived.by(() => {
    if (executionReports.length === 0) return [];
    const report = executionReports[0];
    if (!report) return [];
    return report.stateTransitions.map((t) => t.to);
  });

  /**
   * Convert a kebab-case or snake_case ID to a human-readable label.
   * e.g. "step_analyze_csv" -> "Analyze CSV", "csv-upload-trigger" -> "CSV Upload Trigger"
   */
  function humanLabel(id: string): string {
    return id
      .replace(/^step[-_]/i, "")
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Derive a display badge for an agent based on its type and config.
   * LLM agents show provider, system/atlas agents show the agent ID.
   */
  function agentBadge(agent: AgentConfig): string {
    if (agent.type === "llm" && agent.config) {
      const provider = agent.config.provider;
      return typeof provider === "string" ? provider : "llm";
    }
    return agent.agent ?? agent.type;
  }

  /**
   * Extract the system prompt from an agent config.
   * LLM agents store it in config.prompt, atlas agents at top-level prompt.
   */
  function agentPrompt(agent: AgentConfig): string | undefined {
    if (agent.prompt) return agent.prompt;
    if (agent.config && typeof agent.config.prompt === "string") return agent.config.prompt;
    return undefined;
  }

  // Progressive artifact processing: populate sections as data arrives during generation.
  // Blueprint → top bar, signals, agents. FSM → diagram, state cards. workspace.yml → final parse.
  $effect(() => {
    if (!executing) return;

    // Phase: blueprint arrived → populate top bar, signals, agents
    if (artifacts["blueprint"] && generationPhase === "generating") {
      try {
        const blueprint = JSON.parse(artifacts["blueprint"]);
        const ws = blueprint.workspace ?? {};
        const signals: Record<string, SignalConfig> = {};
        for (const sig of blueprint.signals ?? []) {
          signals[sig.id ?? sig.name ?? "unknown"] = {
            provider: sig.type ?? "manual",
            description: sig.description ?? "",
            title: sig.name,
            config: sig.config,
            schema: sig.payload_schema,
          };
        }
        const agents: Record<string, AgentConfig> = {};
        for (const agent of blueprint.agents ?? []) {
          agents[agent.id ?? agent.name ?? "unknown"] = {
            type: agent.executionType ?? agent.type ?? "llm",
            description: agent.description ?? "",
            prompt: agent.prompt,
            config: agent.config,
          };
        }
        workspaceData = {
          workspace: { name: ws.name, description: ws.purpose },
          signals,
          agents,
          jobs: {},
          tools: {},
          raw: "",
        };
        generationPhase = "blueprint";
      } catch {
        console.warn("Failed to parse blueprint artifact");
      }
    }

    // Phase: FSM compiled → enrich with FSM data
    if (artifacts["fsm"] && generationPhase === "blueprint" && workspaceData) {
      try {
        const raw: unknown = JSON.parse(artifacts["fsm"]);
        const FsmArraySchema = z.array(z.object({ id: z.string() }).passthrough());
        const fsms = FsmArraySchema.parse(raw);
        const jobs: Record<string, JobData> = {};
        for (const fsm of fsms) {
          // Zod validated shape; full FSMDefinition arrives from server pipeline
          jobs[fsm.id] = { name: fsm.id, fsm: fsm as unknown as FSMDefinition };
        }
        workspaceData = { ...workspaceData, jobs };
        generationPhase = "compiled";
      } catch {
        console.warn("Failed to parse FSM artifact");
      }
    }
  });

  // When generation completes and we have a workspace.yml artifact, do final parse
  // which replaces incremental data with the fully validated workspace config.
  $effect(() => {
    if (doneEvent && artifacts["workspace.yml"]) {
      generationPhase = "assembled";
      parseYamlContent(artifacts["workspace.yml"]);
      if (doneEvent.slug) {
        goto(`/workspaces?run=${encodeURIComponent(doneEvent.slug)}`, { replaceState: true });
      }
      // Reset phase once generation is fully done
      generationPhase = "idle";
    }
  });

  // On mount, if the URL has a ?run= param, load that run's workspace.yml artifact.
  $effect(() => {
    const runSlug = page.url.searchParams.get("run");
    if (runSlug && !workspaceData && !executing) {
      loadRunFromSlug(runSlug);
    }
  });

  /**
   * Load a previously saved run's workspace.yml from the server.
   * @param slug - The run directory slug
   */
  async function loadRunFromSlug(slug: string) {
    try {
      const res = await getClient().api.workspace.runs[":slug"].$get({ param: { slug } });
      if (!res.ok) return;
      const body = await res.json();
      const yaml = body.artifacts?.["workspace.yml"];
      if (typeof yaml === "string") {
        await parseYamlContent(yaml);
      }
    } catch {
      console.warn("Failed to load run:", slug);
    }
  }

  /** Cancel the active SSE stream. */
  function cancel() {
    if (!activeReader) return;
    cancelled = true;
    activeReader.cancel();
    activeReader = null;
  }

  /** Reset to initial state. */
  function reset() {
    cancel();
    prompt = "";
    events = [];
    executing = false;
    cancelled = false;
    parseError = null;
    workspaceData = null;
    dragging = false;
    expandedAgent = null;
    generationPhase = "idle";
    showLogs = false;
    executionReports = [];
    executionStepIndex = -1;
    if (page.url.searchParams.has("run")) {
      goto("/workspaces", { replaceState: true });
    }
  }

  /**
   * Parse SSE text stream into typed events.
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
                events = [...events, { type: eventType, data: parsed } as SSEEvent];
              } catch {
                console.warn("Failed to parse SSE data:", eventData);
              }
            }
          }
        }
      } catch {
        if (!cancelled) {
          events = [...events, { type: "error", data: { error: "Connection lost" } }];
        }
      } finally {
        activeReader = null;
        executing = false;
      }
    })();
  }

  /**
   * Parse YAML content via the server and populate workspace data.
   * @param yaml - Raw YAML string to parse
   * @param persist - Whether to save to history (true for user-loaded, false for auto-parse after generate)
   */
  async function parseYamlContent(yaml: string, persist = false) {
    parseError = null;

    try {
      const res = await getClient().api.workspace.parse.$post({ json: { yaml } });

      if (!res.ok) {
        const text = await res.text();
        parseError = `Parse failed: ${text}`;
        return;
      }

      const body = await res.json();
      workspaceData = {
        workspace: (body.workspace.workspace ?? {}) as WorkspaceData["workspace"],
        signals: (body.workspace.signals ?? {}) as WorkspaceData["signals"],
        agents: (body.workspace.agents ?? {}) as WorkspaceData["agents"],
        jobs: (body.workspace.jobs ?? {}) as WorkspaceData["jobs"],
        tools: (body.workspace.tools ?? {}) as WorkspaceData["tools"],
        raw: yaml,
      };

      if (persist) {
        const name = workspaceData.workspace.name;
        try {
          const saveRes = await getClient().api.workspace.save.$post({ json: { yaml, name } });
          if (saveRes.ok) {
            const saveBody = await saveRes.json();
            if (saveBody.slug) {
              goto(`/workspaces?run=${encodeURIComponent(saveBody.slug)}`, { replaceState: true });
            }
          }
        } catch {
          console.warn("Failed to save workspace to history");
        }
      }
    } catch {
      parseError = "Failed to connect to server";
    }
  }

  /** Handle file drop or file input change. */
  async function handleFile(file: File) {
    const text = await file.text();
    await parseYamlContent(text, true);
  }

  /** Generate workspace from prompt via SSE pipeline. */
  async function generate() {
    if (!prompt.trim()) return;

    if (activeReader) {
      activeReader.cancel();
      activeReader = null;
    }
    events = [];
    executing = true;
    cancelled = false;
    parseError = null;
    workspaceData = null;
    generationPhase = "generating";

    try {
      const res = await getClient().api.workspace.execute.$post({
        json: { prompt: prompt.trim() },
      });

      if (!res.ok) {
        const text = await res.text();
        events = [{ type: "error", data: { error: `HTTP ${res.status}: ${text}` } }];
        executing = false;
        return;
      }
      if (!res.body) {
        events = [{ type: "error", data: { error: "No response body" } }];
        executing = false;
        return;
      }

      parseSSEStream(res.body);
    } catch {
      if (!cancelled) {
        events = [...events, { type: "error", data: { error: "Connection lost" } }];
      }
      executing = false;
    }
  }

  /** Handle execution reports from ExecutionPanel. */
  function handleExecutionReport(reports: ExecutionReport[]) {
    executionReports = reports;
    executionStepIndex = -1;
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    dragging = true;
  }

  function handleDragLeave() {
    dragging = false;
  }

  async function handleDrop(e: DragEvent) {
    e.preventDefault();
    dragging = false;
    const file = e.dataTransfer?.files[0];
    if (file) {
      await handleFile(file);
    }
  }

  function handleFileInput(e: Event) {
    const target = e.target as HTMLInputElement;
    const file = target.files?.[0];
    if (file) {
      handleFile(file);
    }
  }

  /** Get transport label for an MCP server. */
  function transportLabel(transport: MCPTransport): string {
    if (transport.type === "stdio") return `stdio: ${transport.command ?? "unknown"}`;
    if (transport.type === "http") return transport.url ?? "http";
    return transport.type;
  }

  /** Get required fields from a JSON Schema object. */
  function getRequiredFields(schema: Record<string, unknown>): string[] {
    const required = schema.required;
    return Array.isArray(required)
      ? required.filter((r): r is string => typeof r === "string")
      : [];
  }

  /** Get property names from a JSON Schema object. */
  function getPropertyNames(schema: Record<string, unknown>): string[] {
    const props = schema.properties;
    return props && typeof props === "object" ? Object.keys(props) : [];
  }

  /** Get the type string for a JSON Schema property (e.g. "string", "array", "object"). */
  function getPropertyType(schema: Record<string, unknown>, field: string): string {
    const props = schema.properties as Record<string, Record<string, unknown>> | undefined;
    if (!props?.[field]) return "";
    const prop = props[field];
    const t = prop.type;
    if (typeof t === "string") return t;
    return "";
  }

  /**
   * Get a compact label for an FSM entry action.
   * Returns badge (action type) and target (function name, agent ID, etc.)
   */
  function actionSummary(action: Action): { badge: string; target: string } {
    switch (action.type) {
      case "code":
        return { badge: "code", target: action.function };
      case "agent":
        return {
          badge: "agent",
          target: `${action.agentId}${action.outputTo ? ` → ${action.outputTo}` : ""}`,
        };
      case "emit":
        return { badge: "emit", target: action.event };
      case "llm":
        return {
          badge: "llm",
          target: `${action.model}${action.outputTo ? ` → ${action.outputTo}` : ""}`,
        };
      default:
        return { badge: "unknown", target: "" };
    }
  }
</script>

<!-- Content area: CSS grid with main content + drawer column -->
<div class="content-area" class:drawer-open={workspaceData !== null}>
  <div class="main-scroll">
    {#if workspaceData}
      <!-- Top bar: workspace name, description, controls -->
      <header class="top-bar">
        <div class="top-bar-info">
          {#if workspaceData.workspace.name}
            <h1 class="workspace-name">{workspaceData.workspace.name}</h1>
          {/if}
          {#if workspaceData.workspace.description}
            <p class="workspace-description">{workspaceData.workspace.description}</p>
          {/if}
        </div>
        <div class="top-bar-controls">
          <button class="clear-btn" onclick={reset} title="Clear workspace">
            <IconSmall.X />
          </button>
        </div>
      </header>

      <!-- Section containers in pipeline order -->
      <div class="inspector-sections">
        <!-- Signals chip rail -->
        {#if signalEntries.length > 0}
          <section class="inspector-section" data-section="signals">
            <span class="section-trigger">
              <span class="section-label">Signals</span>
            </span>
            <div class="signal-rail">
              {#each signalEntries as [name, signal] (name)}
                <button
                  class="signal-chip"
                  class:expanded={expandedSignal === name}
                  data-provider={signal.provider}
                  onclick={() => {
                    expandedSignal = expandedSignal === name ? null : name;
                  }}
                >
                  <span class="signal-chip-name">{signal.title ?? name}</span>
                  <span class="signal-chip-badge">{signal.provider}</span>
                </button>
              {/each}
            </div>
            {#if expandedSignal}
              {@const signal = workspaceData?.signals[expandedSignal]}
              {#if signal}
                <div class="signal-detail" data-provider={signal.provider}>
                  <div class="signal-detail-header">
                    <span class="signal-detail-name">{expandedSignal}</span>
                    <button
                      class="signal-detail-close"
                      onclick={() => {
                        expandedSignal = null;
                      }}
                    >
                      <IconSmall.X />
                    </button>
                  </div>
                  {#if signal.description}
                    <p class="signal-detail-description">{signal.description}</p>
                  {/if}
                  {#if signal.config}
                    <div class="signal-detail-section">
                      <span class="signal-detail-label">Config</span>
                      {#each Object.entries(signal.config) as [key, value] (key)}
                        <div class="detail-row">
                          <span class="detail-key">{key}</span>
                          <span class="detail-value">
                            {typeof value === "object" ? JSON.stringify(value) : String(value)}
                          </span>
                        </div>
                      {/each}
                    </div>
                  {/if}
                  {#if signal.schema?.properties}
                    <div class="signal-detail-section">
                      <span class="signal-detail-label">Payload Schema</span>
                      {#each Object.entries(signal.schema.properties as Record<string, Record<string, unknown>>) as [field, def] (field)}
                        <div class="detail-row">
                          <span class="detail-key">{field}</span>
                          <span class="detail-value">
                            {def.type}{def.format ? ` (${def.format})` : ""}
                          </span>
                        </div>
                      {/each}
                    </div>
                  {/if}
                </div>
              {/if}
            {/if}
          </section>
        {/if}

        <!-- Agents section -->
        {#if agentEntries.length > 0}
          <section class="inspector-section" data-section="agents">
            <span class="section-trigger">
              <span class="section-label">Agents</span>
            </span>
            <div class="agent-grid">
              {#each agentEntries as [name, agent] (name)}
                <button
                  class="agent-card"
                  class:expanded={expandedAgent === name}
                  onclick={() => {
                    expandedAgent = expandedAgent === name ? null : name;
                  }}
                >
                  <div class="agent-card-header">
                    <span class="agent-card-name">{name}</span>
                    <span class="agent-card-badge">{agentBadge(agent)}</span>
                  </div>
                  {#if agent.description}
                    <p class="agent-card-description">{agent.description}</p>
                  {/if}
                  {#if mcpServerNames.length > 0}
                    <div class="agent-mcp-row">
                      {#each mcpServerNames as server (server)}
                        <span class="agent-mcp-pill">{server}</span>
                      {/each}
                    </div>
                  {/if}
                  {#if expandedAgent === name}
                    {@const prompt = agentPrompt(agent)}
                    <div class="agent-card-expanded">
                      {#if prompt}
                        <div class="agent-expanded-section">
                          <span class="agent-expanded-label">System Prompt</span>
                          <pre class="agent-expanded-prompt">{prompt}</pre>
                        </div>
                      {/if}
                      {#if agent.config}
                        <div class="agent-expanded-section">
                          <span class="agent-expanded-label">Config</span>
                          {#each Object.entries(agent.config).filter(([k]) => k !== "prompt") as [key, value] (key)}
                            <div class="detail-row">
                              <span class="detail-key">{key}</span>
                              <span class="detail-value">
                                {typeof value === "object" ? JSON.stringify(value) : String(value)}
                              </span>
                            </div>
                          {/each}
                        </div>
                      {/if}
                    </div>
                  {/if}
                </button>
              {/each}
            </div>
          </section>
        {/if}

        <!-- FSM skeleton during generation (before FSM artifact arrives) -->
        {#if isGenerating && generationPhase === "blueprint" && fsmJobs.length === 0}
          <section class="inspector-section" data-section="fsm">
            <span class="section-trigger">
              <span class="section-label">FSM</span>
            </span>
            <div
              class="skeleton-block skeleton-shimmer"
              style="height: 200px; border-radius: var(--radius-2);"
            ></div>
          </section>
        {/if}

        <!-- FSM State Diagrams per job -->
        {#each fsmJobs as { id, fsm } (id)}
          <section class="inspector-section" data-section="fsm">
            <Collapsible.Root defaultOpen={true}>
              <Collapsible.Trigger size="grow">
                {#snippet children(open)}
                  <span class="section-trigger">
                    {#if open}
                      <IconSmall.CaretDown />
                    {:else}
                      <IconSmall.CaretRight />
                    {/if}
                    <span class="section-label">FSM: {id}</span>
                  </span>
                {/snippet}
              </Collapsible.Trigger>
              <Collapsible.Content>
                <div class="fsm-container">
                  <FSMStateDiagram {fsm} />
                </div>
              </Collapsible.Content>
            </Collapsible.Root>
          </section>
        {/each}

        <!-- State detail cards grid -->
        {#each fsmJobs as { id, fsm } (`state-cards-${id}`)}
          {@const stateEntries = Object.entries(fsm.states)}
          {#if stateEntries.length > 0}
            <section class="inspector-section" data-section="state-cards">
              <span class="section-trigger">
                <span class="section-label">States</span>
                <span class="section-count">{stateEntries.length}</span>
              </span>
              <div class="state-card-grid">
                {#each stateEntries as [stateId, state], i (stateId)}
                  {@const stateType =
                    stateId === fsm.initial ? "initial" : state.type === "final" ? "final" : "step"}
                  {@const isActive = execution.activeState === stateId}
                  {@const isVisited = execution.visitedStates.has(stateId)}
                  <div
                    class="state-card state-card--{stateType}"
                    class:state-card--active={isActive}
                    class:state-card--visited={isVisited && !isActive}
                    style="--i: {i}"
                  >
                    <div class="state-card-header">
                      <span class="state-card-name">{humanLabel(stateId)}</span>
                      <span class="state-card-type">{stateType}</span>
                    </div>
                    {#if "description" in state && typeof state.description === "string"}
                      <p class="state-card-description">{state.description}</p>
                    {/if}
                    {#if state.entry && state.entry.length > 0}
                      <div class="state-card-actions">
                        {#each state.entry as action, j (j)}
                          {@const summary = actionSummary(action)}
                          <div class="state-card-action">
                            <span
                              class="state-action-marker state-action-marker--{summary.badge}"
                            ></span>
                            <span class="state-action-type">{summary.badge}</span>
                            {#if summary.target}
                              <span class="state-action-target">{summary.target}</span>
                            {/if}
                          </div>
                        {/each}
                      </div>
                    {/if}
                    {#if state.on}
                      <div class="state-card-transitions">
                        {#each Object.entries(state.on) as [signal, transition] (signal)}
                          {@const targets = Array.isArray(transition) ? transition : [transition]}
                          {#each targets as t, k (k)}
                            <div class="state-card-transition">
                              <span class="transition-signal">on {signal}</span>
                              <span class="transition-arrow">&rarr;</span>
                              <span class="transition-target">{humanLabel(t.target)}</span>
                            </div>
                          {/each}
                        {/each}
                      </div>
                    {/if}
                  </div>
                {/each}
              </div>
            </section>
          {/if}
        {/each}

        <!-- Contracts / Document Types section -->
        {#if documentTypes.length > 0}
          <section class="inspector-section" data-section="contracts">
            <Collapsible.Root defaultOpen={true}>
              <Collapsible.Trigger size="grow">
                {#snippet children(open)}
                  <span class="section-trigger">
                    {#if open}
                      <IconSmall.CaretDown />
                    {:else}
                      <IconSmall.CaretRight />
                    {/if}
                    <span class="section-label">Contracts</span>
                    <span class="section-count">{documentTypes.length}</span>
                  </span>
                {/snippet}
              </Collapsible.Trigger>
              <Collapsible.Content>
                <div class="contract-grid">
                  {#each documentTypes as doc (doc.docId)}
                    {@const fields = getPropertyNames(doc.schema)}
                    {@const requiredFields = getRequiredFields(doc.schema)}
                    {@const hasOverflow = fields.length > 5}
                    <div class="contract-card">
                      <div class="contract-header">
                        <span class="contract-name" title={doc.docId}>{doc.docId}</span>
                        {#if doc.producingState}
                          <span class="contract-producer" title="Produced by {doc.producingState}">
                            {humanLabel(doc.producingState)}
                          </span>
                        {/if}
                      </div>
                      {#if fields.length > 0}
                        <div
                          class="contract-fields"
                          class:collapsed={hasOverflow}
                          id="contract-{doc.docId}"
                        >
                          {#each fields as field (field)}
                            {@const fieldType = getPropertyType(doc.schema, field)}
                            <div class="contract-field">
                              <span class="contract-field-name">{field}</span>
                              {#if fieldType}
                                <span class="type-badge">{fieldType}</span>
                              {/if}
                              {#if requiredFields.includes(field)}
                                <span class="required-badge">req</span>
                              {/if}
                            </div>
                          {/each}
                        </div>
                        {#if hasOverflow}
                          <button
                            class="contract-expand"
                            onclick={(e) => {
                              const target = (e.currentTarget as HTMLElement)
                                .previousElementSibling;
                              if (target) target.classList.toggle("collapsed");
                              const btn = e.currentTarget as HTMLElement;
                              btn.textContent = target?.classList.contains("collapsed")
                                ? `+${fields.length - 5} more`
                                : "Show less";
                            }}
                          >
                            +{fields.length - 5} more
                          </button>
                        {/if}
                      {/if}
                    </div>
                  {/each}
                </div>
              </Collapsible.Content>
            </Collapsible.Root>
          </section>
        {/if}

        <!-- Resources / MCP Servers section -->
        {#if mcpServers.length > 0}
          <section class="inspector-section" data-section="resources">
            <Collapsible.Root defaultOpen={true}>
              <Collapsible.Trigger size="grow">
                {#snippet children(open)}
                  <span class="section-trigger">
                    {#if open}
                      <IconSmall.CaretDown />
                    {:else}
                      <IconSmall.CaretRight />
                    {/if}
                    <span class="section-label">Resources</span>
                    <span class="section-count">{mcpServers.length}</span>
                  </span>
                {/snippet}
              </Collapsible.Trigger>
              <Collapsible.Content>
                <div class="card-grid">
                  {#each mcpServers as [name, server] (name)}
                    <div class="card">
                      <div class="card-header">
                        <span class="card-name">{name}</span>
                        <span class="card-badge">{server.transport.type}</span>
                      </div>
                      <div class="detail-row">
                        <span class="detail-key">transport</span>
                        <span class="detail-value">{transportLabel(server.transport)}</span>
                      </div>
                      {#if server.tools}
                        <div class="card-details">
                          {#if server.tools.allow}
                            <div class="detail-row">
                              <span class="detail-key">allow</span>
                              <span class="detail-value">{server.tools.allow.join(", ")}</span>
                            </div>
                          {/if}
                          {#if server.tools.deny}
                            <div class="detail-row">
                              <span class="detail-key">deny</span>
                              <span class="detail-value">{server.tools.deny.join(", ")}</span>
                            </div>
                          {/if}
                        </div>
                      {/if}
                    </div>
                  {/each}
                </div>
              </Collapsible.Content>
            </Collapsible.Root>
          </section>
        {/if}

        <!-- Execution section -->
        {#if prompt.trim().length > 0}
          <section class="inspector-section" data-section="execution">
            <Collapsible.Root defaultOpen={true}>
              <Collapsible.Trigger size="grow">
                {#snippet children(open)}
                  <span class="section-trigger">
                    {#if open}
                      <IconSmall.CaretDown />
                    {:else}
                      <IconSmall.CaretRight />
                    {/if}
                    <span class="section-label">Execute</span>
                  </span>
                {/snippet}
              </Collapsible.Trigger>
              <Collapsible.Content>
                <ExecutionPanel {prompt} onreport={handleExecutionReport} />
              </Collapsible.Content>
            </Collapsible.Root>
          </section>
        {/if}

        <!-- Results Accumulator (shown after execution) -->
        {#if executionReports.length > 0 && executionReports[0]}
          <section class="inspector-section" data-section="results">
            <Collapsible.Root defaultOpen={true}>
              <Collapsible.Trigger size="grow">
                {#snippet children(open)}
                  <span class="section-trigger">
                    {#if open}
                      <IconSmall.CaretDown />
                    {:else}
                      <IconSmall.CaretRight />
                    {/if}
                    <span class="section-label">Results</span>
                  </span>
                {/snippet}
              </Collapsible.Trigger>
              <Collapsible.Content>
                <ResultsAccumulator
                  snapshots={executionReports[0].resultSnapshots}
                  {stateOrder}
                  stepIndex={executionStepIndex}
                />
              </Collapsible.Content>
            </Collapsible.Root>
          </section>

          <!-- Action Trace -->
          <section class="inspector-section" data-section="trace">
            <Collapsible.Root defaultOpen={false}>
              <Collapsible.Trigger size="grow">
                {#snippet children(open)}
                  <span class="section-trigger">
                    {#if open}
                      <IconSmall.CaretDown />
                    {:else}
                      <IconSmall.CaretRight />
                    {/if}
                    <span class="section-label">Action Trace</span>
                    <span class="section-count">{executionReports[0].actionTrace.length}</span>
                  </span>
                {/snippet}
              </Collapsible.Trigger>
              <Collapsible.Content>
                <ActionTrace
                  actions={executionReports[0].actionTrace}
                  stepIndex={executionStepIndex}
                  {stateOrder}
                />
              </Collapsible.Content>
            </Collapsible.Root>
          </section>
        {/if}

        <!-- Streaming log panel during generation -->
        {#if isGenerating && streamEvents.length > 0}
          <section class="inspector-section" data-section="logs">
            <button
              class="section-trigger log-toggle"
              onclick={() => {
                showLogs = !showLogs;
              }}
            >
              {#if showLogs}
                <IconSmall.CaretDown />
              {:else}
                <IconSmall.CaretRight />
              {/if}
              <span class="section-label">Pipeline Log</span>
              <span class="section-count">{streamEvents.length}</span>
              {#if executing}
                <span class="generation-indicator"></span>
              {/if}
            </button>
            {#if showLogs}
              <div class="generation-log">
                <ExecutionStream events={streamEvents} {executing} {cancelled} />
              </div>
            {/if}
          </section>
        {/if}

        <!-- YAML preview section -->
        {#if workspaceData.raw}
          <section class="inspector-section" data-section="yaml">
            <Collapsible.Root defaultOpen={false}>
              <Collapsible.Trigger size="grow">
                {#snippet children(open)}
                  <span class="section-trigger">
                    {#if open}
                      <IconSmall.CaretDown />
                    {:else}
                      <IconSmall.CaretRight />
                    {/if}
                    <span class="section-label">YAML</span>
                  </span>
                {/snippet}
              </Collapsible.Trigger>
              <Collapsible.Content>
                <pre class="yaml-preview">{workspaceData.raw}</pre>
              </Collapsible.Content>
            </Collapsible.Root>
          </section>
        {/if}
      </div>
    {:else if events.length > 0 || executing}
      <!-- Streaming generation output -->
      <section class="output-stream">
        <h2>Pipeline Output</h2>
        <ExecutionStream events={streamEvents} {executing} {cancelled} />
      </section>
    {:else}
      <!-- Entry point: unified generate + load screen -->
      <div class="entry-point">
        <div class="entry-header">
          <h1 class="entry-title">Workspace Inspector</h1>
          <p class="entry-subtitle">Generate a workspace from a prompt or load an existing one</p>
        </div>

        <!-- Generate section -->
        <div class="input-section">
          <label class="input-label" for="prompt-input">Describe your workspace</label>
          <textarea
            id="prompt-input"
            class="prompt-textarea"
            bind:value={prompt}
            placeholder="Describe the workspace you want to build..."
            rows="4"
            onkeydown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canGenerate) {
                generate();
              }
            }}
          ></textarea>
          {#if executing}
            <Button variant="secondary" onclick={cancel}>Cancel</Button>
          {:else}
            <Button variant="primary" disabled={!canGenerate} onclick={generate}>Generate</Button>
          {/if}
        </div>

        <!-- Divider -->
        <div class="entry-divider">
          <span class="entry-divider-line"></span>
          <span class="entry-divider-text">or</span>
          <span class="entry-divider-line"></span>
        </div>

        <!-- Load section -->
        <div
          class="drop-zone"
          class:dragging
          role="button"
          tabindex="0"
          ondragover={handleDragOver}
          ondragleave={handleDragLeave}
          ondrop={handleDrop}
          onclick={() => document.getElementById("file-input")?.click()}
          onkeydown={(e) => {
            if (e.key === "Enter" || e.key === " ") document.getElementById("file-input")?.click();
          }}
        >
          <input
            id="file-input"
            type="file"
            accept=".yml,.yaml"
            class="file-input"
            onchange={handleFileInput}
          />
          <span class="drop-label">Drop workspace.yml here or click to browse</span>
        </div>

        {#if parseError}
          <div class="parse-error">
            <pre>{parseError}</pre>
          </div>
        {/if}
      </div>
    {/if}
  </div>

  <!-- Execution drawer (right side, slides in via grid column transition) -->
  <div class="drawer-column">
    <ExecutionDrawerContent runSlug={page.url.searchParams.get("run")} />
  </div>
</div>

<style>
  /* Layout: CSS grid with main content + drawer column */
  .content-area {
    block-size: 100%;
    display: grid;
    grid-template-columns: 1fr var(--drawer-width, 0px);
    overflow: hidden;
    transition: grid-template-columns 250ms ease-out;

    &.drawer-open {
      --drawer-width: 400px;
    }
  }

  .main-scroll {
    display: flex;
    flex-direction: column;
    min-inline-size: 0;
    overflow-y: auto;
  }

  .drawer-column {
    overflow: hidden;
  }

  /* Top bar */
  .top-bar {
    align-items: center;
    border-block-end: 1px solid var(--color-border-1);
    display: flex;
    flex-shrink: 0;
    gap: var(--size-4);
    justify-content: space-between;
    min-block-size: 64px;
    padding-block: var(--size-3);
    padding-inline: var(--size-5);
  }

  .top-bar-info {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
    min-inline-size: 0;
  }

  .workspace-name {
    font-size: var(--font-size-6);
    font-weight: var(--font-weight-6);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .workspace-description {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-2);
    line-height: var(--font-lineheight-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .top-bar-controls {
    align-items: center;
    display: flex;
    flex-shrink: 0;
    gap: var(--size-2);
  }

  .clear-btn {
    align-items: center;
    background: none;
    border-radius: var(--radius-2);
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    cursor: pointer;
    display: flex;
    justify-content: center;
    padding: var(--size-1);
    transition: color 150ms ease;
  }

  .clear-btn:hover {
    color: var(--color-text);
  }

  /* Inspector sections */
  .inspector-sections {
    display: flex;
    flex-direction: column;
    gap: var(--size-4);
    padding: var(--size-5);
  }

  .inspector-section {
    animation: sectionFadeIn 0.35s ease-out both;
  }

  /* Stagger section appearance by DOM order */
  .inspector-section:nth-child(1) {
    animation-delay: 0ms;
  }
  .inspector-section:nth-child(2) {
    animation-delay: 60ms;
  }
  .inspector-section:nth-child(3) {
    animation-delay: 120ms;
  }
  .inspector-section:nth-child(4) {
    animation-delay: 180ms;
  }
  .inspector-section:nth-child(5) {
    animation-delay: 240ms;
  }
  .inspector-section:nth-child(n + 6) {
    animation-delay: 300ms;
  }

  @keyframes sectionFadeIn {
    from {
      opacity: 0;
      transform: translateY(8px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  /* Skeleton shimmer placeholder */
  .skeleton-block {
    background-color: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
  }

  .skeleton-shimmer {
    overflow: hidden;
    position: relative;
  }

  .skeleton-shimmer::after {
    animation: shimmer 1.5s ease-in-out infinite;
    background: linear-gradient(
      90deg,
      transparent 0%,
      color-mix(in srgb, var(--color-text), transparent 95%) 50%,
      transparent 100%
    );
    block-size: 100%;
    content: "";
    inline-size: 100%;
    inset-block-start: 0;
    inset-inline-start: 0;
    position: absolute;
  }

  @keyframes shimmer {
    0% {
      transform: translateX(-100%);
    }
    100% {
      transform: translateX(100%);
    }
  }

  /* Generation indicator dot */
  .generation-indicator {
    animation: pulse 1.2s ease-in-out infinite;
    background-color: var(--color-accent);
    block-size: 6px;
    border-radius: var(--radius-round);
    inline-size: 6px;
    margin-inline-start: var(--size-1);
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.3;
    }
  }

  /* Log toggle button */
  .log-toggle {
    background: none;
    border: none;
    cursor: pointer;
    font: inherit;
  }

  /* Generation log panel */
  .generation-log {
    background-color: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    max-block-size: 300px;
    overflow-y: auto;
    padding: var(--size-3);
  }

  .section-trigger {
    align-items: center;
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    display: flex;
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    gap: var(--size-1);
    letter-spacing: var(--font-letterspacing-2);
    padding-block: var(--size-1);
    text-transform: uppercase;
  }

  .section-label {
    /* Inherits from .section-trigger */
  }

  .section-count {
    background-color: var(--color-surface-2);
    border-radius: var(--radius-round);
    font-size: var(--font-size-0);
    min-inline-size: var(--size-4);
    padding-inline: var(--size-1);
    text-align: center;
  }

  /* Signal chip rail */
  .signal-rail {
    display: flex;
    gap: var(--size-2);
    overflow-x: auto;
    padding-block: var(--size-1);
    scrollbar-width: thin;
  }

  .signal-chip {
    align-items: center;
    background-color: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-inline-start: 3px solid var(--color-border-1);
    border-radius: var(--radius-2);
    color: var(--color-text);
    cursor: pointer;
    display: flex;
    flex-shrink: 0;
    gap: var(--size-2);
    padding-block: var(--size-1-5);
    padding-inline: var(--size-3);
    transition:
      border-color 150ms ease,
      background-color 150ms ease;
  }

  .signal-chip:hover {
    background-color: var(--color-highlight-1);
  }

  .signal-chip.expanded {
    border-color: color-mix(in srgb, var(--color-text), transparent 60%);
  }

  .signal-chip[data-provider="http"] {
    border-inline-start-color: var(--color-warning);
  }

  .signal-chip[data-provider="cron"] {
    border-inline-start-color: var(--color-info);
  }

  .signal-chip-name {
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    white-space: nowrap;
  }

  .signal-chip-badge {
    background-color: var(--color-highlight-1);
    border-radius: var(--radius-round);
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-0);
    padding-block: var(--size-0-5);
    padding-inline: var(--size-2);
  }

  .signal-detail {
    background-color: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-inline-start: 3px solid var(--color-border-1);
    border-radius: var(--radius-2);
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    padding: var(--size-3);
  }

  .signal-detail[data-provider="http"] {
    border-inline-start-color: var(--color-warning);
  }

  .signal-detail[data-provider="cron"] {
    border-inline-start-color: var(--color-info);
  }

  .signal-detail-header {
    align-items: center;
    display: flex;
    justify-content: space-between;
  }

  .signal-detail-name {
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
  }

  .signal-detail-close {
    background: none;
    border: none;
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    cursor: pointer;
    padding: var(--size-1);
  }

  .signal-detail-close:hover {
    color: var(--color-text);
  }

  .signal-detail-description {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-1);
    line-height: var(--font-lineheight-3);
  }

  .signal-detail-section {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  .signal-detail-label {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-0);
    font-weight: var(--font-weight-5);
    letter-spacing: var(--font-letterspacing-2);
    text-transform: uppercase;
  }

  /* Agent cards */
  .agent-grid {
    display: grid;
    gap: var(--size-3);
    grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
    padding-block-start: var(--size-2);
  }

  .agent-card {
    background-color: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    color: var(--color-text);
    cursor: pointer;
    display: flex;
    flex-direction: column;
    font: inherit;
    gap: var(--size-2);
    padding: var(--size-3);
    text-align: start;
    transition:
      border-color 150ms ease,
      background-color 150ms ease;
  }

  .agent-card:hover {
    background-color: var(--color-highlight-1);
  }

  .agent-card.expanded {
    border-color: color-mix(in srgb, var(--color-text), transparent 60%);
  }

  .agent-card-header {
    align-items: center;
    display: flex;
    gap: var(--size-2);
    justify-content: space-between;
  }

  .agent-card-name {
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-6);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .agent-card-badge {
    background-color: var(--color-highlight-1);
    border-radius: var(--radius-round);
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    flex-shrink: 0;
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-0);
    padding-block: var(--size-0-5);
    padding-inline: var(--size-2);
  }

  .agent-card-description {
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    display: -webkit-box;
    font-size: var(--font-size-2);
    line-height: var(--font-lineheight-3);
    overflow: hidden;
  }

  .agent-mcp-row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--size-1);
    padding-block-start: var(--size-1);
  }

  .agent-mcp-pill {
    background-color: color-mix(in srgb, var(--color-accent), transparent 88%);
    border-radius: var(--radius-round);
    color: var(--color-accent);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-0);
    padding-block: var(--size-0-5);
    padding-inline: var(--size-2);
  }

  .agent-card-expanded {
    border-block-start: 1px solid var(--color-border-1);
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
    padding-block-start: var(--size-2);
  }

  .agent-expanded-section {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  .agent-expanded-label {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-0);
    font-weight: var(--font-weight-5);
    letter-spacing: var(--font-letterspacing-2);
    text-transform: uppercase;
  }

  .agent-expanded-prompt {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-0);
    line-height: var(--font-lineheight-3);
    max-height: 12lh;
    overflow: hidden;
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* Entry point (no workspace loaded) */
  .entry-point {
    display: flex;
    flex-direction: column;
    gap: var(--size-5);
    margin-inline: auto;
    max-inline-size: 560px;
    padding-block: var(--size-8);
    padding-inline: var(--size-5);
  }

  .entry-header {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .entry-title {
    font-size: var(--font-size-7);
    font-weight: var(--font-weight-6);
  }

  .entry-subtitle {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-3);
  }

  .entry-divider {
    align-items: center;
    display: flex;
    gap: var(--size-3);
  }

  .entry-divider-line {
    background-color: var(--color-border-1);
    block-size: 1px;
    flex: 1;
  }

  .entry-divider-text {
    color: color-mix(in srgb, var(--color-text), transparent 60%);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    letter-spacing: var(--font-letterspacing-2);
    text-transform: uppercase;
  }

  .drop-zone {
    align-items: center;
    border: 2px dashed var(--color-border-1);
    border-radius: var(--radius-2);
    cursor: pointer;
    display: flex;
    justify-content: center;
    min-block-size: 120px;
    padding: var(--size-5);
    transition:
      border-color 150ms ease,
      background-color 150ms ease;
  }

  .drop-zone:hover,
  .drop-zone.dragging {
    background-color: var(--color-highlight-1);
    border-color: color-mix(in srgb, var(--color-text), transparent 60%);
  }

  .drop-label {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-2);
    text-align: center;
  }

  .file-input {
    display: none;
  }

  .input-section {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .input-label {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    letter-spacing: var(--font-letterspacing-2);
    text-transform: uppercase;
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

  .parse-error {
    background-color: color-mix(in srgb, var(--color-error), transparent 90%);
    border: 1px solid var(--color-error);
    border-radius: var(--radius-2);
    padding: var(--size-3);

    pre {
      color: var(--color-error);
      font-family: var(--font-family-monospace);
      font-size: var(--font-size-1);
      line-height: var(--font-lineheight-3);
      white-space: pre-wrap;
      word-break: break-word;
    }
  }

  /* Streaming output */
  .output-stream {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--size-3);
    min-block-size: 0;
    overflow-y: auto;
    padding-block: var(--size-4);
    padding-inline: var(--size-5);

    h2 {
      color: color-mix(in srgb, var(--color-text), transparent 40%);
      font-size: var(--font-size-1);
      font-weight: var(--font-weight-5);
      letter-spacing: var(--font-letterspacing-2);
      text-transform: uppercase;
    }
  }

  /* Card grid shared styles */
  .card-grid {
    display: grid;
    gap: var(--size-3);
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    padding-block-start: var(--size-2);
  }

  .card {
    background-color: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    padding: var(--size-3);
  }

  .card-header {
    align-items: center;
    display: flex;
    gap: var(--size-2);
    justify-content: space-between;
  }

  .card-name {
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .card-badge {
    background-color: var(--color-highlight-1);
    border-radius: var(--radius-round);
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    flex-shrink: 0;
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-0);
    padding-block: var(--size-0-5);
    padding-inline: var(--size-2);
  }

  .card-description {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-1);
    line-height: var(--font-lineheight-3);
  }

  .card-subtitle {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-size: var(--font-size-1);
    font-style: italic;
    line-height: var(--font-lineheight-3);
  }

  .card-prompt {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-0);
    line-height: var(--font-lineheight-3);
    max-height: 6lh;
    overflow: hidden;
    white-space: pre-wrap;
  }

  .card-details {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  .detail-row {
    display: flex;
    font-size: var(--font-size-1);
    gap: var(--size-2);
  }

  .detail-key {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    flex-shrink: 0;
    font-family: var(--font-family-monospace);
  }

  .detail-value {
    font-family: var(--font-family-monospace);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .detail-label {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-size: var(--font-size-0);
    font-weight: var(--font-weight-5);
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  /* FSM section */
  .fsm-container {
    padding-block-start: var(--size-2);
  }

  /* State detail cards */
  .state-card-grid {
    display: grid;
    gap: var(--size-3);
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    padding-block-start: var(--size-2);
  }

  @keyframes fadeUp {
    from {
      opacity: 0;
      transform: translateY(8px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .state-card {
    animation: fadeUp 0.35s ease-out both;
    animation-delay: calc(var(--i) * 60ms);
    background-color: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-block-start: 3px solid var(--color-border-1);
    border-radius: var(--radius-2);
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    padding: var(--size-3);
  }

  .state-card--initial {
    border-block-start-color: var(--color-warning);
  }

  .state-card--final {
    border-block-start-color: var(--color-success);
  }

  .state-card--active {
    animation: card-breathe 2s ease-in-out infinite;
    border-color: rgba(59, 130, 246, 0.5);
    border-block-start-color: #3b82f6;
  }

  @keyframes card-breathe {
    0%,
    100% {
      box-shadow: 0 0 6px rgba(59, 130, 246, 0.2);
    }
    50% {
      box-shadow: 0 0 14px rgba(59, 130, 246, 0.45);
    }
  }

  .state-card--visited {
    border-color: rgba(34, 197, 94, 0.3);
    border-block-start-color: #22c55e;
    transition: border-color 0.3s ease;
  }

  .state-card-header {
    align-items: center;
    display: flex;
    gap: var(--size-2);
    justify-content: space-between;
  }

  .state-card-name {
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-6);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .state-card-type {
    background-color: var(--color-highlight-1);
    border-radius: var(--radius-round);
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    flex-shrink: 0;
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-0);
    padding-block: var(--size-0-5);
    padding-inline: var(--size-2);
  }

  .state-card-description {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-1);
    line-height: var(--font-lineheight-3);
  }

  .state-card-actions {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  .state-card-action {
    align-items: center;
    display: flex;
    font-size: var(--font-size-1);
    gap: var(--size-1-5);
  }

  .state-action-marker {
    block-size: 8px;
    border-radius: var(--radius-round);
    flex-shrink: 0;
    inline-size: 8px;
  }

  .state-action-marker--code {
    background-color: #d97706;
  }

  .state-action-marker--llm {
    background-color: #3b82f6;
  }

  .state-action-marker--agent {
    background-color: #22c55e;
  }

  .state-action-marker--emit {
    background-color: #6b7280;
  }

  .state-action-type {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-0);
    font-weight: var(--font-weight-5);
  }

  .state-action-target {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-0);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .state-card-transitions {
    border-block-start: 1px solid var(--color-border-1);
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
    padding-block-start: var(--size-2);
  }

  .state-card-transition {
    align-items: center;
    display: flex;
    font-size: var(--font-size-1);
    gap: var(--size-1-5);
  }

  .transition-signal {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-0);
  }

  .transition-arrow {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-0);
  }

  .transition-target {
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-0);
    font-weight: var(--font-weight-5);
  }

  /* Schema / contracts */
  .schema-field {
    display: flex;
    flex-direction: column;
    gap: var(--size-0-5);
  }

  .schema-description {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-0);
    line-height: var(--font-lineheight-3);
    padding-inline-start: var(--size-1);
  }

  .type-badge {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-0);
  }

  .required-badge {
    background-color: color-mix(in srgb, var(--color-warning) 20%, transparent);
    border-radius: var(--radius-1);
    color: var(--color-warning);
    font-size: var(--font-size-0);
    font-weight: var(--font-weight-5);
    letter-spacing: var(--font-letterspacing-2);
    padding-block: var(--size-0-5);
    padding-inline: var(--size-1);
    text-transform: uppercase;
  }

  .nested-fields {
    border-inline-start: 1px solid var(--color-border-1);
    display: flex;
    flex-direction: column;
    gap: var(--size-0-5);
    margin-inline-start: var(--size-2);
    padding-inline-start: var(--size-2);
  }

  .nested-row {
    font-size: var(--font-size-0);
  }

  /* Contract compact cards */
  .contract-grid {
    display: grid;
    gap: var(--size-2);
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    padding-block-start: var(--size-2);
  }

  .contract-card {
    background-color: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    display: flex;
    flex-direction: column;
    gap: var(--size-1-5);
    padding: var(--size-2) var(--size-3);
  }

  .contract-header {
    align-items: baseline;
    display: flex;
    gap: var(--size-2);
    justify-content: space-between;
  }

  .contract-name {
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .contract-producer {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    flex-shrink: 0;
    font-size: var(--font-size-0);
  }

  .contract-fields {
    display: flex;
    flex-direction: column;
    gap: var(--size-0-5);
  }

  .contract-fields.collapsed {
    max-block-size: calc(5 * 1.5rem);
    overflow: hidden;
  }

  .contract-field {
    align-items: center;
    display: flex;
    font-size: var(--font-size-1);
    gap: var(--size-1-5);
  }

  .contract-field-name {
    color: var(--color-text);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-0);
  }

  .contract-expand {
    background: none;
    border: none;
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    cursor: pointer;
    font-size: var(--font-size-0);
    padding: 0;
    text-align: start;
  }

  .contract-expand:hover {
    color: var(--color-text);
  }

  /* YAML preview */
  .yaml-preview {
    background-color: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-2);
    line-height: var(--font-lineheight-3);
    max-block-size: 600px;
    overflow-y: auto;
    padding: var(--size-3);
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
