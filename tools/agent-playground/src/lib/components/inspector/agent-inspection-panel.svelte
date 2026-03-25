<!--
  Agent block inspection panel — tabbed detail view (Overview, Input, Output, Trace).

  Shown when a waterfall row is selected. Session-level metadata lives in the
  sidebar now; this component only handles individual block inspection.

  @component
  @param {import("@atlas/core/session/session-events").AgentBlock | null} block
  @param {() => void} onclose
-->

<script lang="ts">
  import type { AgentBlock } from "@atlas/core/session/session-events";
  import type { ResolvedStepAgent } from "$lib/inspector-state.svelte";
  import { Icons, StatusBadge } from "@atlas/ui";
  import JsonTree from "$lib/components/shared/json-tree.svelte";
  import { quintOut } from "svelte/easing";
  import { slide } from "svelte/transition";

  interface Props {
    block: AgentBlock | null;
    resolvedStepAgent?: ResolvedStepAgent | null;
    workspaceId?: string | null;
    onclose: () => void;
  }

  const { block, resolvedStepAgent = null, workspaceId = null, onclose }: Props = $props();

  type TabId = "overview" | "input" | "output" | "trace";
  let activeTab = $state<TabId>("overview");

  let copiedPane: "input" | "output" | null = $state(null);
  let promptExpanded = $state(false);

  function copyJson(pane: "input" | "output") {
    const data = pane === "input" ? block?.input : block?.output;
    if (data == null) return;
    navigator.clipboard.writeText(JSON.stringify(data, null, 2));
    copiedPane = pane;
    setTimeout(() => (copiedPane = null), 1500);
  }

  /** Panel height in pixels. */
  let panelHeight = $state(300);
  let panelEl: HTMLDivElement | undefined = $state();
  let dragging = $state(false);

  function startDrag(e: PointerEvent) {
    e.preventDefault();
    dragging = true;
    const startY = e.clientY;
    const startHeight = panelEl?.clientHeight ?? panelHeight;

    function onMove(ev: PointerEvent) {
      const dy = startY - ev.clientY;
      const sessionMain = panelEl?.closest(".session-main");
      const maxHeight = sessionMain
        ? sessionMain.clientHeight - 120
        : window.innerHeight * 0.8;
      panelHeight = Math.max(120, Math.min(maxHeight, startHeight + dy));
    }

    function onUp() {
      dragging = false;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  const toolCallCount = $derived(block?.toolCalls?.length ?? 0);
  const hasInput = $derived(block?.input != null && Object.keys(block.input).length > 0);
  const hasOutput = $derived(block?.output != null);
  const hasToolCalls = $derived(toolCallCount > 0);
  const hasTrace = $derived(hasToolCalls || (block?.ephemeral?.length ?? 0) > 0);
  const hasEphemeral = $derived((block?.ephemeral?.length ?? 0) > 0);

  /** Map AgentBlock status to StatusBadge status prop. */
  const statusMap: Record<string, "completed" | "failed" | "active" | "skipped" | "pending"> = {
    running: "active",
    completed: "completed",
    failed: "failed",
    skipped: "skipped",
    pending: "pending",
  };

  function formatDuration(ms: number | undefined): string {
    if (ms == null) return "—";
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }

  function displayJson(value: unknown): string {
    return JSON.stringify(value, null, 2);
  }
</script>

{#if block}
  <div
    class="inspection-panel"
    bind:this={panelEl}
    style="block-size: {panelHeight}px"
    transition:slide={{ duration: 250, easing: quintOut }}
  >
    <!-- Drag handle -->
    <div
      class="drag-handle"
      class:drag-handle--active={dragging}
      onpointerdown={startDrag}
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize inspection panel"
    ></div>

    {#if block.status === "skipped"}
      <!-- Skipped state: simple message instead of full tab UI -->
      <div class="skipped-panel">
        <div class="skipped-content">
          <StatusBadge status="skipped" />
          <span class="skipped-message">This step was disabled and did not execute.</span>
        </div>
        <button class="close-btn" onclick={onclose} title="Close panel (Esc)">&times;</button>
      </div>
    {:else}
      <!-- Tab bar -->
      <div class="tab-bar">
        <div class="tab-list">
          <button
            class="tab"
            class:tab--active={activeTab === "overview"}
            onclick={() => { activeTab = "overview"; }}
          >
            Overview
          </button>
          <button
            class="tab"
            class:tab--active={activeTab === "input"}
            class:tab--disabled={!hasInput}
            onclick={() => { activeTab = "input"; }}
          >
            Input
          </button>
          <button
            class="tab"
            class:tab--active={activeTab === "output"}
            class:tab--disabled={!hasOutput}
            onclick={() => { activeTab = "output"; }}
          >
            Output
          </button>
          {#if hasTrace}
            <button
              class="tab"
              class:tab--active={activeTab === "trace"}
              onclick={() => { activeTab = "trace"; }}
            >
              Trace{#if toolCallCount > 0}
                <span class="tab-badge">({toolCallCount})</span>{/if}
            </button>
          {/if}
        </div>
        <button class="close-btn" onclick={onclose} title="Close panel (Esc)">&times;</button>
      </div>

      <!-- Tab content -->
      <div class="tab-content">
        {#if activeTab === "overview"}
          <div class="overview">
            <!-- Section 1: Agent Identity -->
            <div class="overview-section">
              <div class="agent-identity">
                {#if resolvedStepAgent && workspaceId}
                  <div class="agent-name-row">
                    <a
                      class="agent-link"
                      href="/platform/{workspaceId}/agents"
                    >{resolvedStepAgent.agentId}</a>
                    <span class="agent-type-badge">{resolvedStepAgent.agentType.toUpperCase()}</span>
                    <a
                      class="edit-config-btn"
                      href="/platform/{workspaceId}/edit?path=agents.{resolvedStepAgent.agentId}"
                      title="Edit configuration"
                    >
                      <Icons.Pencil />
                      Edit
                    </a>
                  </div>
                  {#if resolvedStepAgent.agentDescription}
                    <span class="agent-description">{resolvedStepAgent.agentDescription}</span>
                  {/if}
                {:else}
                  <span class="agent-name-fallback">{block.agentName}</span>
                {/if}
              </div>
            </div>

            <!-- Section 2: Step Prompt (conditional) -->
            {#if resolvedStepAgent?.stepPrompt}
              <div class="overview-section">
                <span class="section-label">Prompt</span>
                <div class="prompt-block" class:prompt-block--expanded={promptExpanded}>
                  <pre class="prompt-text">{resolvedStepAgent.stepPrompt}</pre>
                </div>
                <button class="prompt-toggle" onclick={() => { promptExpanded = !promptExpanded; }}>
                  {promptExpanded ? "Show less" : "Show more"}
                </button>
              </div>
            {/if}

            <!-- Section 3: Execution -->
            <div class="overview-section">
              <div class="execution-row">
                <StatusBadge status={statusMap[block.status] ?? "pending"} />
                <span class="execution-duration">{formatDuration(block.durationMs)}</span>
              </div>
              {#if block.task}
                <span class="execution-task">{block.task}</span>
              {/if}
              {#if block.error}
                <span class="execution-error">{block.error}</span>
              {/if}
            </div>
          </div>
        {:else if activeTab === "input"}
          <div class="json-pane">
            {#if hasInput}
              <button class="copy-json-btn" onclick={() => copyJson("input")}>
                {copiedPane === "input" ? "Copied" : "Copy"}
              </button>
              <JsonTree data={block.input} defaultExpanded={2} />
            {:else}
              <span class="empty-tab">No input data</span>
            {/if}
          </div>
        {:else if activeTab === "output"}
          <div class="json-pane">
            {#if hasOutput}
              <button class="copy-json-btn" onclick={() => copyJson("output")}>
                {copiedPane === "output" ? "Copied" : "Copy"}
              </button>
              <JsonTree data={block.output} defaultExpanded={2} />
            {:else}
              <span class="empty-tab">No output data</span>
            {/if}
          </div>
        {:else if activeTab === "trace"}
          <div class="trace-pane">
            {#if hasToolCalls}
              <div class="tool-calls">
                <h4 class="trace-heading">Tool Calls ({block.toolCalls.length})</h4>
                {#each block.toolCalls as call, i (i)}
                  <details class="tool-call">
                    <summary class="tool-call-header">
                      <span class="tool-name">{call.toolName}</span>
                      {#if call.durationMs}
                        <span class="tool-duration">{formatDuration(call.durationMs)}</span>
                      {/if}
                    </summary>
                    <div class="tool-call-body">
                      {#if call.args != null}
                        <div class="tool-section">
                          <span class="tool-section-label">Args</span>
                          <pre class="tool-json">{displayJson(call.args)}</pre>
                        </div>
                      {/if}
                      {#if call.result != null}
                        <div class="tool-section">
                          <span class="tool-section-label">Result</span>
                          <pre class="tool-json">{displayJson(call.result)}</pre>
                        </div>
                      {/if}
                    </div>
                  </details>
                {/each}
              </div>
            {/if}

            {#if hasEphemeral}
              <div class="ephemeral">
                <h4 class="trace-heading">Live Output</h4>
                <pre
                  class="ephemeral-stream">{#each block.ephemeral ?? [] as chunk}{typeof chunk ===
                    "string"
                      ? chunk
                      : JSON.stringify(chunk)}{/each}</pre>
              </div>
            {/if}

            {#if !hasToolCalls && !hasEphemeral}
              <span class="empty-tab">No trace data</span>
            {/if}
          </div>
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  .inspection-panel {
    background: var(--color-surface-1);
    border-block-start: 1px solid color-mix(in srgb, var(--color-text), transparent 85%);
    display: flex;
    flex-direction: column;
    inline-size: 100%;
    min-block-size: 120px;
    outline: none;
    overflow: hidden;
  }

  /* ---- Drag handle ---- */

  .drag-handle {
    background: transparent;
    block-size: 8px;
    cursor: ns-resize;
    flex-shrink: 0;
    position: relative;
    transition: background-color 80ms ease;
  }

  .drag-handle::after {
    background: color-mix(in srgb, var(--color-text), transparent 70%);
    block-size: 2px;
    border-radius: 1px;
    content: "";
    inset-block-start: 3px;
    inset-inline: 35%;
    position: absolute;
    transition:
      background-color 80ms ease,
      inset-inline 150ms ease;
  }

  .drag-handle:hover {
    background: color-mix(in srgb, var(--color-text), transparent 96%);
  }

  .drag-handle:hover::after {
    background: color-mix(in srgb, var(--color-text), transparent 40%);
    inset-inline: 30%;
  }

  .drag-handle--active {
    background: color-mix(in srgb, var(--color-info), transparent 90%);
  }

  .drag-handle--active::after {
    background: var(--color-info);
  }

  /* ---- Skipped state ---- */

  .skipped-panel {
    align-items: center;
    display: flex;
    flex: 1 1 0;
    justify-content: space-between;
    padding-inline: var(--size-3);
  }

  .skipped-content {
    align-items: center;
    display: flex;
    gap: var(--size-3);
  }

  .skipped-message {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-1);
    font-style: italic;
  }

  /* ---- Tab bar (matches SegmentedControl) ---- */

  .tab-bar {
    align-items: center;
    border-block-end: 1px solid color-mix(in srgb, var(--color-text), transparent 90%);
    display: flex;
    flex-shrink: 0;
    padding-block: var(--size-3);
    padding-inline: var(--size-2);
  }

  .tab-list {
    align-items: center;
    block-size: var(--size-6);
    display: flex;
    flex: 1 1 0;
    gap: var(--size-1);
  }

  .tab {
    align-items: center;
    background: none;
    block-size: 100%;
    border: var(--size-px) solid transparent;
    border-radius: var(--radius-2-5);
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    cursor: default;
    display: flex;
    font-family: inherit;
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    padding-inline: var(--size-2);
    transition:
      border-color 150ms ease,
      color 150ms ease;
  }

  .tab--active {
    border-color: var(--color-border-1);
    color: var(--color-text);
  }

  .tab:not(.tab--active):hover {
    border-color: var(--color-border-1);
  }

  .tab--disabled:not(.tab--active) {
    opacity: 0.4;
  }

  .tab:focus-visible {
    border-radius: var(--radius-1);
    outline: 1px solid var(--color-text);
  }

  .tab-badge {
    font-weight: var(--font-weight-4);
    opacity: 0.7;
  }

  .close-btn {
    background: none;
    border: none;
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    cursor: pointer;
    font-size: var(--font-size-4);
    line-height: 1;
    margin-inline-start: auto;
    padding: var(--size-1) var(--size-3);
  }

  .close-btn:hover {
    color: var(--color-text);
  }

  /* ---- Tab content ---- */

  .tab-content {
    flex: 1 1 0;
    overflow: auto;
    padding: var(--size-3);
  }

  .empty-tab {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-1);
    font-style: italic;
  }

  /* ---- Overview tab ---- */

  .overview {
    display: flex;
    flex-direction: column;
    gap: var(--size-4);
  }

  .overview-section {
    display: flex;
    flex-direction: column;
    gap: var(--size-1-5);
  }

  .overview-section + .overview-section {
    border-block-start: 1px solid color-mix(in srgb, var(--color-text), transparent 90%);
    padding-block-start: var(--size-4);
  }

  /* Agent identity */

  .agent-identity {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  .agent-name-row {
    align-items: center;
    display: flex;
    gap: var(--size-2);
  }

  .agent-link {
    color: var(--color-info);
    cursor: pointer;
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-6);
    text-decoration: none;
  }

  .agent-link:hover {
    text-decoration: underline;
  }

  .agent-type-badge {
    background: color-mix(in srgb, var(--color-text), transparent 90%);
    border-radius: var(--radius-1);
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-family: var(--font-mono);
    font-size: var(--font-size-0);
    font-weight: var(--font-weight-6);
    letter-spacing: 0.03em;
    padding: var(--size-px) var(--size-1);
  }

  .edit-config-btn {
    align-items: center;
    color: color-mix(in srgb, var(--color-text), transparent 45%);
    display: flex;
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    gap: var(--size-1-5);
    margin-inline-start: auto;
    text-decoration: none;
  }

  .edit-config-btn:hover {
    color: var(--color-text);
  }

  .agent-description {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-1);
  }

  .agent-name-fallback {
    color: var(--color-text);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-6);
  }

  /* Step prompt */

  .section-label {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
  }

  .prompt-block {
    max-block-size: 100px;
    overflow: hidden;
    position: relative;
  }

  .prompt-block--expanded {
    max-block-size: none;
  }

  .prompt-text {
    background: color-mix(in srgb, var(--color-surface-2), transparent 30%);
    border-radius: var(--radius-2);
    color: var(--color-text);
    font-family: var(--font-mono);
    font-size: var(--font-size-1);
    margin: 0;
    overflow: auto;
    padding: var(--size-2);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .prompt-toggle {
    align-self: flex-start;
    background: none;
    border: none;
    color: var(--color-info);
    cursor: pointer;
    font-family: inherit;
    font-size: var(--font-size-1);
    padding: 0;
  }

  .prompt-toggle:hover {
    text-decoration: underline;
  }

  /* Execution */

  .execution-row {
    align-items: center;
    display: flex;
    gap: var(--size-2);
  }

  .execution-duration {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-family: var(--font-mono);
    font-size: var(--font-size-1);
  }

  .execution-task {
    color: var(--color-text);
    font-size: var(--font-size-2);
  }

  .execution-error {
    color: var(--color-error);
    font-size: var(--font-size-2);
  }

  /* ---- JSON pane (Input/Output) ---- */

  .json-pane {
    block-size: 100%;
    position: relative;
  }

  .copy-json-btn {
    background: none;
    border: none;
    color: var(--color-text);
    cursor: pointer;
    font-family: inherit;
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    inset-block-start: 0;
    inset-inline-end: 0;
    opacity: 0.5;
    position: absolute;
    transition: opacity 0.15s;
    z-index: 1;
  }

  .copy-json-btn:hover {
    opacity: 1;
  }

  /* ---- Trace tab ---- */

  .trace-pane {
    display: flex;
    flex-direction: column;
    gap: var(--size-4);
  }

  .trace-heading {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-6);
    margin-block-end: var(--size-2);
  }

  .tool-calls {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .tool-call {
    border: 1px solid color-mix(in srgb, var(--color-text), transparent 90%);
    border-radius: var(--radius-2);
    overflow: hidden;
  }

  .tool-call-header {
    align-items: center;
    cursor: pointer;
    display: flex;
    font-size: var(--font-size-1);
    gap: var(--size-2);
    padding: var(--size-1-5) var(--size-2);
  }

  .tool-call-header:hover {
    background: color-mix(in srgb, var(--color-text), transparent 95%);
  }

  .tool-name {
    color: var(--color-text);
    font-family: var(--font-mono);
    font-weight: var(--font-weight-6);
  }

  .tool-duration {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-family: var(--font-mono);
    font-size: var(--font-size-0);
    margin-inline-start: auto;
  }

  .tool-call-body {
    border-block-start: 1px solid color-mix(in srgb, var(--color-text), transparent 90%);
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    padding: var(--size-2);
  }

  .tool-section-label {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
  }

  .tool-json {
    background: color-mix(in srgb, var(--color-surface-2), transparent 30%);
    border-radius: var(--radius-2);
    color: var(--color-text);
    font-family: var(--font-mono);
    font-size: var(--font-size-1);
    margin: 0;
    max-block-size: 200px;
    overflow: auto;
    padding: var(--size-2);
    white-space: pre-wrap;
    word-break: break-all;
  }

  /* ---- Ephemeral stream ---- */

  .ephemeral-stream {
    background: color-mix(in srgb, var(--color-surface-2), transparent 30%);
    border-radius: var(--radius-2);
    color: var(--color-text);
    font-family: var(--font-mono);
    font-size: var(--font-size-1);
    margin: 0;
    max-block-size: 300px;
    overflow: auto;
    padding: var(--size-2);
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* ---- Reduced motion ---- */

  @media (prefers-reduced-motion: reduce) {
    .drag-handle,
    .drag-handle::after {
      transition: none;
    }
    .tab {
      transition: none;
    }
  }
</style>
