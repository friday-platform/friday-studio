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
  import { slide } from "svelte/transition";
  import { quintOut } from "svelte/easing";
  import JsonTree from "$lib/components/json-tree.svelte";

  interface Props {
    block: AgentBlock | null;
    onclose: () => void;
  }

  const { block, onclose }: Props = $props();

  type TabId = "overview" | "input" | "output" | "trace";
  let activeTab = $state<TabId>("overview");

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
      panelHeight = Math.max(120, Math.min(window.innerHeight * 0.8, startHeight + dy));
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

  const tabs: TabId[] = ["overview", "input", "output", "trace"];

  function statusLabel(status: string): string {
    return status.charAt(0).toUpperCase() + status.slice(1);
  }

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
        <span class="status-badge status--skipped">Skipped</span>
        <span class="skipped-message">This step was disabled and did not execute.</span>
      </div>
      <button class="close-btn" onclick={onclose} title="Close panel (Esc)">
        &times;
      </button>
    </div>
    {:else}
    <!-- Tab bar -->
    <div class="tab-bar">
      <div class="tabs">
        <button
          class="tab"
          class:tab--active={activeTab === "overview"}
          onclick={() => { activeTab = "overview"; }}
        >Overview</button>
        <button
          class="tab"
          class:tab--active={activeTab === "input"}
          class:tab--empty={!hasInput}
          onclick={() => { activeTab = "input"; }}
        >Input</button>
        <button
          class="tab"
          class:tab--active={activeTab === "output"}
          class:tab--empty={!hasOutput}
          onclick={() => { activeTab = "output"; }}
        >Output</button>
        <button
          class="tab"
          class:tab--active={activeTab === "trace"}
          class:tab--empty={!hasTrace}
          onclick={() => { activeTab = "trace"; }}
        >Trace{#if toolCallCount > 0} <span class="tab-badge">({toolCallCount})</span>{/if}</button>
      </div>
      <button class="close-btn" onclick={onclose} title="Close panel (Esc)">
        &times;
      </button>
    </div>

    <!-- Tab content -->
    <div class="tab-content">
      {#if activeTab === "overview"}
        <div class="overview">
          <div class="overview-field">
            <span class="field-label">Agent</span>
            <span class="field-value">{block.agentName}</span>
          </div>
          {#if block.stateId}
            <div class="overview-field">
              <span class="field-label">State</span>
              <span class="field-value mono">{block.stateId}</span>
            </div>
          {/if}
          <div class="overview-field">
            <span class="field-label">Action</span>
            <span class="field-value mono">{block.actionType}</span>
          </div>
          <div class="overview-field">
            <span class="field-label">Status</span>
            <span class="field-value">
              <span class="status-badge status--{block.status}">
                {statusLabel(block.status)}
              </span>
            </span>
          </div>
          <div class="overview-field">
            <span class="field-label">Duration</span>
            <span class="field-value">{formatDuration(block.durationMs)}</span>
          </div>
          {#if block.task}
            <div class="overview-field">
              <span class="field-label">Task</span>
              <span class="field-value">{block.task}</span>
            </div>
          {/if}
          {#if block.error}
            <div class="overview-field">
              <span class="field-label">Error</span>
              <span class="field-value error-text">{block.error}</span>
            </div>
          {/if}
        </div>

      {:else if activeTab === "input"}
        <div class="json-pane">
          {#if hasInput}
            <JsonTree data={block.input} defaultExpanded={2} />
          {:else}
            <span class="empty-tab">No input data</span>
          {/if}
        </div>

      {:else if activeTab === "output"}
        <div class="json-pane">
          {#if hasOutput}
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
              <pre class="ephemeral-stream">{#each block.ephemeral ?? [] as chunk}{typeof chunk === "string" ? chunk : JSON.stringify(chunk)}{/each}</pre>
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
    block-size: 8px;
    cursor: ns-resize;
    background: transparent;
    flex-shrink: 0;
    position: relative;
    transition: background-color 80ms ease;
  }

  .drag-handle::after {
    content: "";
    position: absolute;
    inset-inline: 35%;
    inset-block-start: 3px;
    block-size: 2px;
    border-radius: 1px;
    background: color-mix(in srgb, var(--color-text), transparent 70%);
    transition: background-color 80ms ease, inset-inline 150ms ease;
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

  /* ---- Tab bar ---- */

  .tab-bar {
    display: flex;
    align-items: center;
    border-block-end: 1px solid color-mix(in srgb, var(--color-text), transparent 90%);
    flex-shrink: 0;
  }

  .tabs {
    display: flex;
    gap: 0;
    flex: 1 1 0;
  }

  .tab {
    background: none;
    border: none;
    border-block-end: 2px solid transparent;
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    cursor: pointer;
    font-family: inherit;
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    padding: var(--size-2) var(--size-3);
    transition: color 150ms ease, border-color 150ms ease;
  }

  .tab:hover {
    color: var(--color-text);
  }

  .tab--active {
    border-block-end-color: var(--color-info);
    color: var(--color-text);
    opacity: 1;
  }

  .tab--empty:not(.tab--active) {
    opacity: 0.4;
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
    animation: tab-fade-in 150ms ease-out;
  }

  @keyframes tab-fade-in {
    from { opacity: 0; transform: translateY(4px); }
    to { opacity: 1; transform: translateY(0); }
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
    gap: var(--size-2);
  }

  .overview-field {
    display: flex;
    align-items: baseline;
    gap: var(--size-3);
  }

  .field-label {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    text-transform: uppercase;
    letter-spacing: var(--font-letterspacing-2);
    flex: 0 0 80px;
  }

  .field-value {
    color: var(--color-text);
    font-size: var(--font-size-2);
  }

  .mono {
    font-family: var(--font-mono);
  }

  .status-badge {
    border-radius: var(--radius-1);
    font-size: var(--font-size-0);
    font-weight: var(--font-weight-6);
    padding: var(--size-0-5) var(--size-1-5);
    text-transform: uppercase;
  }

  .status--running {
    background: color-mix(in srgb, var(--color-info), transparent 85%);
    color: var(--color-info);
  }

  .status--completed {
    background: color-mix(in srgb, var(--color-success, #22c55e), transparent 85%);
    color: var(--color-success, #22c55e);
  }

  .status--failed {
    background: color-mix(in srgb, var(--color-error, #ef4444), transparent 85%);
    color: var(--color-error, #ef4444);
  }

  .status--skipped {
    background: color-mix(in srgb, var(--color-text), transparent 85%);
    color: color-mix(in srgb, var(--color-text), transparent 40%);
  }

  .status--pending {
    background: color-mix(in srgb, var(--color-text), transparent 90%);
    color: color-mix(in srgb, var(--color-text), transparent 50%);
  }

  .error-text {
    color: var(--color-error, #ef4444);
  }

  /* ---- JSON pane (Input/Output) ---- */

  .json-pane {
    block-size: 100%;
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
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: var(--size-2);
    padding: var(--size-1-5) var(--size-2);
    font-size: var(--font-size-1);
  }

  .tool-call-header:hover {
    background: color-mix(in srgb, var(--color-text), transparent 95%);
  }

  .tool-name {
    font-family: var(--font-mono);
    font-weight: var(--font-weight-6);
    color: var(--color-text);
  }

  .tool-duration {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-family: var(--font-mono);
    font-size: var(--font-size-0);
    margin-inline-start: auto;
  }

  .tool-call-body {
    border-block-start: 1px solid color-mix(in srgb, var(--color-text), transparent 90%);
    padding: var(--size-2);
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .tool-section-label {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-0);
    font-weight: var(--font-weight-5);
    text-transform: uppercase;
    letter-spacing: var(--font-letterspacing-2);
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
    .tab-content { animation: none; }
    .drag-handle,
    .drag-handle::after { transition: none; }
    .tab { transition: none; }
  }
</style>
