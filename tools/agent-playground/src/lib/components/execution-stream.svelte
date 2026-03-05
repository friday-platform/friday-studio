<script lang="ts">
  /**
   * Streams SSE events from the execute endpoint and renders them in real-time.
   * Parses `event:` / `data:` lines from a ReadableStream response.
   */
  import type { DoneStats, LogEntry, TraceEntry } from "$lib/server/lib/sse.ts";

  type SSEEvent =
    | { type: "progress"; data: { type: string; [key: string]: unknown } }
    | { type: "log"; data: LogEntry }
    | { type: "trace"; data: TraceEntry }
    | { type: "result"; data: unknown }
    | { type: "done"; data: DoneStats }
    | { type: "error"; data: { error: string } };

  type Props = { events: SSEEvent[]; executing: boolean; cancelled?: boolean };

  let { events, executing, cancelled = false }: Props = $props();

  let streamEnd: HTMLDivElement | undefined = $state();

  /** Auto-scroll to bottom when new events arrive. */
  $effect(() => {
    if (events.length > 0 && streamEnd) {
      streamEnd.scrollIntoView({ behavior: "smooth" });
    }
  });

  /**
   * Format a progress chunk for display.
   * Handles tool calls, text deltas, and data events.
   */
  function formatProgress(data: { type: string; [key: string]: unknown }): string {
    const t = data.type;
    if (t === "tool-call" || t === "tool-result") {
      const name = (data.toolName as string) ?? "tool";
      const args = data.args ? JSON.stringify(data.args) : "";
      const prefix = t === "tool-call" ? "Tool call" : "Tool result";
      return args ? `${prefix}: ${name}(${truncate(args, 120)})` : `${prefix}: ${name}`;
    }
    if (t === "text-delta" || t === "text") {
      return String(data.textDelta ?? data.text ?? "");
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

  /** Collect consecutive text-delta events into merged text blocks. */
  function getMergedEvents(): Array<
    { kind: "text"; text: string } | { kind: "event"; event: SSEEvent }
  > {
    const merged: Array<{ kind: "text"; text: string } | { kind: "event"; event: SSEEvent }> = [];
    for (const ev of events) {
      if (ev.type === "progress" && (ev.data.type === "text-delta" || ev.data.type === "text")) {
        const text = String(ev.data.textDelta ?? ev.data.text ?? "");
        const last = merged[merged.length - 1];
        if (last?.kind === "text") {
          last.text += text;
        } else {
          merged.push({ kind: "text", text });
        }
      } else {
        merged.push({ kind: "event", event: ev });
      }
    }
    return merged;
  }

  const mergedEvents = $derived(getMergedEvents());
</script>

<div class="stream">
  {#if mergedEvents.length === 0 && !executing}
    <div class="empty">Select an agent and enter a prompt to begin.</div>
  {:else}
    {#each mergedEvents as item, i (i)}
      {#if item.kind === "text"}
        <pre class="text-block">{item.text}</pre>
      {:else if item.event.type === "progress"}
        {@const label = formatProgress(item.event.data)}
        {#if item.event.data.type === "tool-call" || item.event.data.type === "tool-result"}
          <div class="event tool">{label}</div>
        {:else if item.event.data.type.startsWith("data-")}
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
          <span class="result-label">Result</span>
          <pre class="result-body">{typeof item.event.data === "string"
              ? item.event.data
              : JSON.stringify(item.event.data, null, 2)}</pre>
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

    {#if executing}
      <div class="spinner">
        <div class="dot"></div>
        <div class="dot"></div>
        <div class="dot"></div>
      </div>
    {:else if cancelled}
      <div class="cancelled">Cancelled</div>
    {/if}

    <div bind:this={streamEnd}></div>
  {/if}
</div>

<style>
  .cancelled {
    border-block-start: 1px solid var(--color-border-1);
    color: color-mix(in srgb, var(--color-text), transparent 40%);
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
    color: color-mix(in srgb, var(--color-text), transparent 50%);
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
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-2);
    line-height: var(--font-lineheight-3);
    max-block-size: 400px;
    overflow-y: auto;
    padding: var(--size-3);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .result-label {
    background-color: var(--color-surface-2);
    border-block-end: 1px solid var(--color-border-1);
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    display: block;
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

  .tool {
    color: color-mix(in srgb, var(--color-text), transparent 20%);
    font-weight: var(--font-weight-5);
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
