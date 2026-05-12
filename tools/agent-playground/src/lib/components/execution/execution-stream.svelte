<script lang="ts">
  /**
   * Streams SSE events from the execute endpoint and renders them in real-time.
   * Parses `event:` / `data:` lines from a ReadableStream response.
   */
  import { browser } from "$app/environment";
  import { MarkdownRendered, markdownToHTML } from "@atlas/ui";
  import DOMPurify from "dompurify";
  import JsonTree from "$lib/components/shared/json-tree.svelte";
  import type { LogEntry, TraceEntry } from "$lib/server/lib/sse.ts";
  import type { SSEEvent } from "$lib/sse-types.ts";
  import type { ExecutionStatus } from "$lib/types/execution-status.ts";

  /** A paired tool call with optional result, grouped by toolCallId. */
  type ToolCallPair = {
    toolCallId: string;
    toolName: string;
    input: unknown | undefined;
    output: unknown | undefined;
    hasResult: boolean;
  };

  type MergedItem =
    | { kind: "text"; text: string }
    | { kind: "tool-call"; pair: ToolCallPair }
    | { kind: "event"; event: SSEEvent };

  type Props = { events: SSEEvent[]; status: ExecutionStatus };

  let { events, status }: Props = $props();

  /** Track which result indices show raw JSON. */
  let showRaw = new Map<number, boolean>();

  /** Track copy button feedback per result index. */
  let copyFeedback = new Map<number, boolean>();

  /** Track which tool calls are expanded, keyed by toolCallId. */
  let expandedTools = $state(new Map<string, boolean>());

  function toggleRaw(index: number) {
    showRaw.set(index, !showRaw.get(index));
    showRaw = new Map(showRaw);
  }

  async function copyResult(data: unknown, index: number) {
    const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    await navigator.clipboard.writeText(text);
    copyFeedback.set(index, true);
    copyFeedback = new Map(copyFeedback);
    setTimeout(() => {
      copyFeedback.set(index, false);
      copyFeedback = new Map(copyFeedback);
    }, 1500);
  }

  function toggleToolCall(toolCallId: string) {
    expandedTools.set(toolCallId, !expandedTools.get(toolCallId));
    expandedTools = new Map(expandedTools);
  }

  let streamEnd: HTMLDivElement | undefined = $state();

  /** Auto-scroll to bottom when new events arrive. */
  $effect(() => {
    if (events.length > 0 && streamEnd) {
      streamEnd.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  });

  /** Tool-related chunk types from AI SDK v5. */
  const TOOL_INPUT_TYPES = new Set([
    "tool-input-start",
    "tool-input-available",
    "tool-input-delta",
    "tool-input-error",
    // Legacy v4 type names (in case any code path still emits them)
    "tool-call",
  ]);

  const TOOL_OUTPUT_TYPES = new Set([
    "tool-output-available",
    "tool-output-error",
    // Legacy v4 type name
    "tool-result",
  ]);

  /**
   * Format a progress chunk for display.
   * Handles text deltas and data events. Tool calls are handled separately.
   */
  function formatProgress(data: { type: string; [key: string]: unknown }): string {
    const t = data.type;
    if (t === "text-delta" || t === "text") {
      return String(data.textDelta ?? data.delta ?? data.text ?? "");
    }
    // Data events (agent-start, intent, etc.)
    if (t.startsWith("data-")) {
      const label = t.replace("data-", "");
      const content = data.data;
      if (content && typeof content === "object" && "content" in content) {
        return `${label}: ${(content as { content: string }).content}`;
      }
      return label;
    }
    return `${t}: ${truncate(JSON.stringify(data), 200)}`;
  }

  function truncate(s: string, max: number): string {
    return s.length > max ? s.slice(0, max) + "..." : s;
  }

  /**
   * Collect consecutive text-delta events into merged text blocks,
   * and group tool-call/tool-result events by toolCallId.
   */
  function getMergedEvents(): MergedItem[] {
    const merged: MergedItem[] = [];
    /** Buffer tool calls by toolCallId for pairing. */
    const toolPairs = new Map<string, ToolCallPair>();

    for (const ev of events) {
      // Merge consecutive text deltas
      if (ev.type === "progress" && (ev.data.type === "text-delta" || ev.data.type === "text")) {
        const text = String(ev.data.textDelta ?? ev.data.delta ?? ev.data.text ?? "");
        const last = merged[merged.length - 1];
        if (last?.kind === "text") {
          last.text += text;
        } else {
          merged.push({ kind: "text", text });
        }
        continue;
      }

      // Group tool input events
      if (ev.type === "progress" && TOOL_INPUT_TYPES.has(ev.data.type)) {
        const toolCallId = ev.data.toolCallId as string | undefined;
        if (!toolCallId) {
          // No toolCallId — render as generic event
          merged.push({ kind: "event", event: ev });
          continue;
        }

        const existing = toolPairs.get(toolCallId);
        if (existing) {
          // Update with more info (tool-input-available has input)
          if (ev.data.toolName) existing.toolName = ev.data.toolName as string;
          if (ev.data.input !== undefined) existing.input = ev.data.input;
          // v4 compat: args field
          if (ev.data.args !== undefined) existing.input = ev.data.args;
        } else {
          const pair: ToolCallPair = {
            toolCallId,
            toolName: (ev.data.toolName as string) ?? "tool",
            input: ev.data.input ?? ev.data.args,
            output: undefined,
            hasResult: false,
          };
          toolPairs.set(toolCallId, pair);
          merged.push({ kind: "tool-call", pair });
        }
        continue;
      }

      // Group tool output events
      if (ev.type === "progress" && TOOL_OUTPUT_TYPES.has(ev.data.type)) {
        const toolCallId = ev.data.toolCallId as string | undefined;
        if (!toolCallId) {
          merged.push({ kind: "event", event: ev });
          continue;
        }

        const existing = toolPairs.get(toolCallId);
        if (existing) {
          existing.output = ev.data.output ?? ev.data.result;
          existing.hasResult = true;
        } else {
          // Standalone result with no matching call — create a pair anyway
          const pair: ToolCallPair = {
            toolCallId,
            toolName: (ev.data.toolName as string) ?? "tool",
            input: undefined,
            output: ev.data.output ?? ev.data.result,
            hasResult: true,
          };
          toolPairs.set(toolCallId, pair);
          merged.push({ kind: "tool-call", pair });
        }
        continue;
      }

      // Everything else passes through
      merged.push({ kind: "event", event: ev });
    }

    return merged;
  }

  const mergedEvents = $derived(getMergedEvents());
</script>

<div class="stream">
  {#if mergedEvents.length === 0 && status.state !== "running"}
    <div class="empty">Select an agent and enter a prompt to begin.</div>
  {:else}
    {#each mergedEvents as item, i (i)}
      {#if item.kind === "text"}
        <pre class="text-block">{item.text}</pre>
      {:else if item.kind === "tool-call"}
        {@const pair = item.pair}
        {@const isExpanded = expandedTools.get(pair.toolCallId) ?? false}
        <div class="tool-call-group">
          <button
            class="tool-call-header"
            onclick={() => toggleToolCall(pair.toolCallId)}
            aria-expanded={isExpanded}
          >
            <span class="tool-call-caret" class:tool-call-caret-expanded={isExpanded}>&#9662;</span>
            <span class="tool-call-name">{pair.toolName}</span>
            {#if pair.hasResult}
              <span class="tool-call-status tool-call-done">done</span>
            {:else}
              <span class="tool-call-status tool-call-pending">
                <span class="tool-call-dot"></span>
                <span class="tool-call-dot"></span>
                <span class="tool-call-dot"></span>
              </span>
            {/if}
          </button>
          {#if isExpanded}
            <div class="tool-call-body">
              {#if pair.input !== undefined}
                <div class="tool-call-section">
                  <div class="tool-call-section-label">Input</div>
                  <div class="tool-call-section-content">
                    <JsonTree data={pair.input} defaultExpanded={2} />
                  </div>
                </div>
              {/if}
              {#if pair.hasResult}
                <div class="tool-call-section">
                  <div class="tool-call-section-label">Output</div>
                  <div class="tool-call-section-content">
                    {#if typeof pair.output === "string"}
                      <pre class="tool-call-text">{pair.output}</pre>
                    {:else}
                      <JsonTree data={pair.output} defaultExpanded={2} />
                    {/if}
                  </div>
                </div>
              {:else}
                <div class="tool-call-section">
                  <div class="tool-call-section-label">Output</div>
                  <div class="tool-call-section-content tool-call-waiting">
                    Waiting for result...
                  </div>
                </div>
              {/if}
            </div>
          {/if}
        </div>
      {:else if item.event.type === "progress"}
        {@const label = formatProgress(item.event.data)}
        {#if item.event.data.type.startsWith("data-")}
          <div class="event data">{label}</div>
        {:else}
          <div class="event">{label}</div>
        {/if}
      {:else if item.event.type === "log"}
        <div
          class="event log"
          class:log-error={item.event.data.level === "error"}
          class:log-warn={item.event.data.level === "warn"}
        >
          <span class="log-level">{item.event.data.level}</span>
          {item.event.data.message}
        </div>
      {:else if item.event.type === "result"}
        <div class="result">
          <div class="result-label">
            <span>Result</span>
            <div class="result-actions">
              <button class="result-action" onclick={() => copyResult(item.event.data, i)}>
                {copyFeedback.get(i) ? "Copied!" : "Copy"}
              </button>
              <button class="result-action" onclick={() => toggleRaw(i)}>
                {showRaw.get(i) ? "Formatted" : "Raw"}
              </button>
            </div>
          </div>
          {#if showRaw.get(i)}
            <pre class="result-body">{typeof item.event.data === "string"
                ? item.event.data
                : JSON.stringify(item.event.data, null, 2)}</pre>
          {:else if typeof item.event.data === "string"}
            <div class="result-body">
              <MarkdownRendered>
                {@html browser ? DOMPurify.sanitize(markdownToHTML(item.event.data)) : markdownToHTML(item.event.data)}
              </MarkdownRendered>
            </div>
          {:else}
            <div class="result-body">
              <JsonTree data={item.event.data} defaultExpanded={2} />
            </div>
          {/if}
        </div>
      {:else if item.event.type === "done"}
        <div class="done">
          Completed in {item.event.data.durationMs}ms
          {#if item.event.data.totalTokens}
            — {item.event.data.totalTokens.toLocaleString()} tokens
          {/if}
          {#if item.event.data.stepCount}
            — {item.event.data.stepCount} {item.event.data.stepCount === 1 ? "step" : "steps"}
          {/if}
        </div>
      {:else if item.event.type === "error"}
        <div class="event error">{item.event.data.error}</div>
      {/if}
    {/each}

    {#if status.state === "running"}
      <div class="spinner">
        <div class="dot"></div>
        <div class="dot"></div>
        <div class="dot"></div>
      </div>
    {:else if status.state === "cancelled"}
      <div class="cancelled">Cancelled</div>
    {/if}

    <div bind:this={streamEnd}></div>
  {/if}
</div>

<style>
  .cancelled {
    border-block-start: 1px solid var(--color-border-1);
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    font-size: var(--font-size-1);
    font-style: italic;
    margin-block-start: var(--size-3);
    padding-block-start: var(--size-3);
  }

  .done {
    border-block-start: 1px solid var(--color-border-1);
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-size: var(--font-size-1);
    margin-block-start: var(--size-3);
    padding-block-start: var(--size-3);
  }

  .dot {
    animation: pulse 1.2s infinite ease-in-out;
    background-color: color-mix(in srgb, var(--color-text), transparent 60%);
    block-size: 6px;
    border-radius: var(--radius-round);
    inline-size: 6px;
  }

  .dot:nth-child(2) {
    animation-delay: 0.2s;
  }

  .dot:nth-child(3) {
    animation-delay: 0.4s;
  }

  .empty {
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    font-size: var(--font-size-3);
    padding-block: var(--size-8);
    text-align: center;
  }

  .error {
    color: var(--color-error);
    font-weight: var(--font-weight-5);
  }

  .event {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-1);
    line-height: var(--font-lineheight-3);
    padding-block: var(--size-0-5);
  }

  .log {
    opacity: 0.6;
  }

  .log-error {
    color: var(--color-error);
    opacity: 1;
  }

  .log-level {
    font-weight: var(--font-weight-5);
    margin-inline-end: var(--size-1);
    text-transform: uppercase;
  }

  .log-warn {
    opacity: 0.8;
  }

  .result {
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    margin-block-start: var(--size-3);
    overflow: hidden;
  }

  .result-body {
    max-block-size: 400px;
    overflow-y: auto;
    padding: var(--size-3);
  }

  pre.result-body {
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-2);
    line-height: var(--font-lineheight-3);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .result-action {
    background: none;
    border: none;
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    cursor: pointer;
    font-size: var(--font-size-0);
    padding: 0;
  }

  .result-action:hover {
    color: var(--color-text);
  }

  .result-actions {
    display: flex;
    gap: var(--size-3);
    margin-inline-start: auto;
  }

  .result-label {
    align-items: center;
    background-color: var(--color-surface-2);
    border-block-end: 1px solid var(--color-border-1);
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    display: flex;
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    letter-spacing: var(--font-letterspacing-2);
    padding-block: var(--size-1-5);
    padding-inline: var(--size-3);
    text-transform: uppercase;
  }

  .spinner {
    display: flex;
    gap: var(--size-1);
    padding-block: var(--size-2);
  }

  .stream {
    display: flex;
    flex-direction: column;
  }

  .text-block {
    font-family: var(--font-family-sans);
    font-size: var(--font-size-3);
    line-height: var(--font-lineheight-3);
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* Tool call group — expandable paired tool call/result */

  .tool-call-body {
    border-block-start: 1px solid var(--color-border-1);
    display: flex;
    flex-direction: column;
  }

  .tool-call-caret {
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    display: inline-block;
    flex-shrink: 0;
    font-size: 10px;
    transform: rotate(-90deg);
    transition: transform 150ms ease;
  }

  .tool-call-caret-expanded {
    transform: rotate(0deg);
  }

  .tool-call-done {
    color: color-mix(in srgb, var(--color-success), transparent 30%);
    font-size: var(--font-size-0);
    font-weight: var(--font-weight-4);
  }

  .tool-call-dot {
    animation: pulse 1.2s infinite ease-in-out;
    background-color: color-mix(in srgb, var(--color-text), transparent 60%);
    block-size: 4px;
    border-radius: var(--radius-round);
    inline-size: 4px;
  }

  .tool-call-dot:nth-child(2) {
    animation-delay: 0.2s;
  }

  .tool-call-dot:nth-child(3) {
    animation-delay: 0.4s;
  }

  .tool-call-group {
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    margin-block: var(--size-1);
    overflow: hidden;
  }

  .tool-call-header {
    align-items: center;
    background: none;
    border: none;
    color: var(--color-text);
    cursor: pointer;
    display: flex;
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    gap: var(--size-1-5);
    inline-size: 100%;
    padding-block: var(--size-1-5);
    padding-inline: var(--size-2);
    text-align: start;
  }

  .tool-call-header:hover {
    background-color: var(--color-surface-2);
  }

  .tool-call-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tool-call-pending {
    align-items: center;
    display: flex;
    gap: 3px;
  }

  .tool-call-section {
    border-block-start: 1px solid color-mix(in srgb, var(--color-border-1), transparent 50%);
  }

  .tool-call-section:first-child {
    border-block-start: none;
  }

  .tool-call-section-content {
    max-block-size: 300px;
    overflow-y: auto;
    padding: var(--size-2) var(--size-3);
  }

  .tool-call-section-label {
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    font-size: var(--font-size-0);
    font-weight: var(--font-weight-5);
    letter-spacing: var(--font-letterspacing-2);
    padding-block-start: var(--size-1-5);
    padding-inline: var(--size-3);
    text-transform: uppercase;
  }

  .tool-call-text {
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-2);
    line-height: var(--font-lineheight-3);
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .tool-call-waiting {
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    font-size: var(--font-size-1);
    font-style: italic;
  }

  @keyframes pulse {
    0%,
    80%,
    100% {
      opacity: 0.3;
      transform: scale(0.8);
    }
    40% {
      opacity: 1;
      transform: scale(1);
    }
  }
</style>
