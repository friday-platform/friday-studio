<script lang="ts">
  import { tick } from "svelte";
  import type { ChatMessage, ToolCallDisplay } from "./types";

  interface Props {
    open: boolean;
    chatId: string;
    messages: ChatMessage[];
    systemPromptContext: { timestamp: string; systemMessages: string[] } | null;
    workspaceName: string;
    status: string;
  }

  const {
    open,
    chatId,
    messages,
    systemPromptContext,
    workspaceName,
    status,
  }: Props = $props();

  let activeTab: "context" | "tools" | "timeline" | "waterfall" | "prompt" = $state("context");

  /**
   * Debounced message snapshot — only updates when message COUNT changes
   * or status transitions, not on every streaming text-delta. This prevents
   * the inspector's derived computations from re-running hundreds of times
   * per second during streaming (which caused a 4.6s main thread block).
   */
  let snapshotMessages = $state<ChatMessage[]>([]);
  let lastSnapshotCount = 0;
  let lastSnapshotStatus = "";
  $effect(() => {
    const count = messages.length;
    const s = status;
    if (count !== lastSnapshotCount || (s === "idle" && lastSnapshotStatus !== "idle")) {
      lastSnapshotCount = count;
      lastSnapshotStatus = s;
      snapshotMessages = messages;
    }
    lastSnapshotStatus = s;
  });

  /**
   * Turn-level timing tracker. Records when each user message appears and
   * when the assistant response completes, building a per-turn waterfall.
   */
  interface TurnTiming {
    userMessageId: string;
    userText: string;
    startMs: number;
    firstResponseMs?: number;  // first assistant message part appeared
    endMs?: number;
    toolCalls: Array<{
      name: string;
      state: string;
      firstSeenMs: number;
      doneMs?: number;
    }>;
  }

  // Use an untracked store to avoid $effect read/write loops
  const timingsStore: TurnTiming[] = [];
  const rehydratedStore = new Set<string>();
  let storeInitialized = false;
  let turnTimingsVersion = $state(0);

  // Snapshot for rendering — only changes when version bumps
  let turnTimings = $state<TurnTiming[]>([]);

  // Track timing — ONLY when inspector is open to avoid performance impact
  $effect(() => {
    if (!open) return; // Critical: don't subscribe to messages when closed
    const msgs = snapshotMessages;
    const currentStatus = status;
    const now = Date.now();

    // First run: mark existing messages as rehydrated
    if (!storeInitialized) {
      storeInitialized = true;
      for (const m of msgs) rehydratedStore.add(m.id);
      return;
    }

    let changed = false;

    // Track NEW user messages
    for (const msg of msgs) {
      if (msg.role === "user" && !rehydratedStore.has(msg.id) && !timingsStore.find((t) => t.userMessageId === msg.id)) {
        timingsStore.push({
          userMessageId: msg.id,
          userText: msg.content,
          startMs: now,
          toolCalls: [],
        });
        changed = true;
      }
    }

    // Update active turns
    for (const timing of timingsStore) {
      if (timing.endMs) continue;

      const userIdx = msgs.findIndex((m) => m.id === timing.userMessageId);
      if (userIdx < 0) continue;
      const assistantMsg = msgs.slice(userIdx + 1).find((m) => m.role === "assistant");

      // Track first response (assistant message appeared)
      if (assistantMsg && !timing.firstResponseMs) {
        timing.firstResponseMs = now;
        changed = true;
      }

      if (assistantMsg?.toolCalls) {
        for (const tc of assistantMsg.toolCalls) {
          const existing = timing.toolCalls.find((t) => t.name === tc.toolName && t.state !== "output-available");
          if (!existing) {
            timing.toolCalls.push({
              name: tc.toolName,
              state: tc.state,
              firstSeenMs: now,
              doneMs: tc.state === "output-available" || tc.state === "output-error" ? now : undefined,
            });
            changed = true;
          } else if (existing.state !== tc.state) {
            existing.state = tc.state;
            if ((tc.state === "output-available" || tc.state === "output-error") && !existing.doneMs) {
              existing.doneMs = now;
            }
            changed = true;
          }
        }
      }

      // Close the turn when assistant has content and either:
      // - A subsequent user message exists (next turn started)
      // - Status is idle (streaming finished)
      // - Status is not streaming/submitted (catch-all for completed state)
      if (assistantMsg && assistantMsg.content.length > 0) {
        const isLastUser = msgs.filter((m) => m.role === "user").at(-1)?.id === timing.userMessageId;
        const isDone = !isLastUser || currentStatus === "idle" || (currentStatus !== "streaming" && currentStatus !== "submitted");
        if (isDone) {
          timing.endMs = now;
          changed = true;
        }
      }
    }

    if (changed) {
      // Copy to reactive state for rendering
      turnTimings = timingsStore.map((t) => ({ ...t, toolCalls: [...t.toolCalls] }));
      turnTimingsVersion++;
    }
  });

  /** Computed waterfall data from turn timings. */
  const waterfallTurns = $derived.by(() => {
    if (!open) return [];
    const now = Date.now();
    const turns: Array<{
      userText: string;
      totalMs: number;
      isActive: boolean;
      bars: Array<{
        label: string;
        durationMs: number;
        type: "tool" | "waiting" | "response";
        state: string;
        offsetPct: number;
        widthPct: number;
      }>;
    }> = [];

    for (const timing of turnTimings) {
      // Use current time for active turns
      const totalMs = (timing.endMs ?? now) - timing.startMs;
      if (totalMs <= 0) continue;
      const isActive = !timing.endMs;

      const bars: typeof turns[number]["bars"] = [];

      if (timing.toolCalls.length > 0) {
        // Add waiting phase (from user message to first tool call)
        const firstToolMs = Math.min(...timing.toolCalls.map((t) => t.firstSeenMs));
        const waitMs = firstToolMs - timing.startMs;
        if (waitMs > 100) {
          bars.push({
            label: "waiting",
            durationMs: waitMs,
            type: "waiting",
            state: "done",
            offsetPct: 0,
            widthPct: Math.max(2, (waitMs / totalMs) * 100),
          });
        }

        // Tool call bars
        for (const tc of timing.toolCalls) {
          const start = tc.firstSeenMs - timing.startMs;
          const dur = (tc.doneMs ?? now) - tc.firstSeenMs;
          bars.push({
            label: tc.name,
            durationMs: dur,
            type: "tool",
            state: tc.state,
            offsetPct: Math.max(0, (start / totalMs) * 100),
            widthPct: Math.max(2, (dur / totalMs) * 100),
          });
        }

        // Response phase (from last tool done to end)
        const lastToolDone = Math.max(...timing.toolCalls.map((t) => t.doneMs ?? now));
        const responseMs = (timing.endMs ?? now) - lastToolDone;
        if (responseMs > 100) {
          bars.push({
            label: "response",
            durationMs: responseMs,
            type: "response",
            state: isActive ? "streaming" : "done",
            offsetPct: Math.max(0, ((lastToolDone - timing.startMs) / totalMs) * 100),
            widthPct: Math.max(2, (responseMs / totalMs) * 100),
          });
        }
      } else {
        // No tools — show waiting + response
        bars.push({
          label: isActive ? "processing..." : "response",
          durationMs: totalMs,
          type: isActive ? "waiting" : "response",
          state: isActive ? "streaming" : "done",
          offsetPct: 0,
          widthPct: 100,
        });
      }

      turns.push({
        userText: timing.userText.slice(0, 40) + (timing.userText.length > 40 ? "..." : ""),
        totalMs,
        isActive,
        bars,
      });
    }
    return turns;
  });

  /** No active ticker — waterfall updates when messages change naturally. */

  function formatMs(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }

  /** All unique tool names used across all assistant messages. */
  const usedTools = $derived.by(() => {
    if (!open) return new Set<string>();
    const names = new Set<string>();
    for (const msg of snapshotMessages) {
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          names.add(tc.toolName);
        }
      }
    }
    return names;
  });

  /** All tool calls flattened with message context. */
  const allToolCalls = $derived.by(() => {
    if (!open) return [];
    const calls: Array<ToolCallDisplay & { messageId: string }> = [];
    for (const msg of snapshotMessages) {
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          calls.push({ ...tc, messageId: msg.id });
        }
      }
    }
    return calls;
  });

  /** Timeline entries: messages + tool calls interleaved. */
  const timeline = $derived.by(() => {
    if (!open) return [];
    const entries: Array<{
      type: "user" | "assistant" | "tool";
      timestamp: number;
      content: string;
      toolName?: string;
      toolState?: string;
      duration?: string;
    }> = [];
    for (const msg of snapshotMessages) {
      if (msg.role === "user") {
        entries.push({
          type: "user",
          timestamp: msg.timestamp,
          content: msg.content,
        });
      }
      if (msg.role === "assistant") {
        if (msg.toolCalls) {
          for (const tc of msg.toolCalls) {
            entries.push({
              type: "tool",
              timestamp: msg.timestamp,
              content: argPreview(tc),
              toolName: tc.toolName,
              toolState: tc.state,
            });
          }
        }
        if (msg.content.length > 0) {
          entries.push({
            type: "assistant",
            timestamp: msg.timestamp,
            content: msg.content,
          });
        }
      }
    }
    return entries;
  });

  function argPreview(tc: ToolCallDisplay): string {
    if (typeof tc.input !== "object" || tc.input === null) return "";
    const obj = tc.input as Record<string, unknown>;
    const first = Object.values(obj).find((v) => typeof v === "string");
    if (typeof first === "string") return first.length > 50 ? first.slice(0, 50) + "..." : first;
    return "";
  }

  function stateIcon(state: string): string {
    if (state === "output-available") return "✓";
    if (state === "output-error" || state === "output-denied") return "✗";
    return "⟳";
  }

  const tabs = [
    { id: "context" as const, label: "Context" },
    { id: "tools" as const, label: "Tools" },
    { id: "timeline" as const, label: "Timeline" },
    { id: "waterfall" as const, label: "Waterfall" },
    { id: "prompt" as const, label: "Prompt" },
  ];
</script>

{#if open}
  <div class="inspector">
    <div class="inspector-tabs">
      {#each tabs as tab (tab.id)}
        <button
          class="tab"
          class:active={activeTab === tab.id}
          onclick={() => activeTab = tab.id}
        >
          {tab.label}
          {#if tab.id === "tools"}
            <span class="badge">{usedTools.size}</span>
          {/if}
          {#if tab.id === "timeline"}
            <span class="badge">{timeline.length}</span>
          {/if}
        </button>
      {/each}
    </div>

    <div class="inspector-body">
      {#if activeTab === "context"}
        <div class="section">
          <h4>Session</h4>
          <dl class="kv-list">
            <dt>Chat ID</dt>
            <dd class="mono">{chatId.slice(0, 8)}</dd>
            <dt>Workspace</dt>
            <dd>{workspaceName}</dd>
            <dt>Status</dt>
            <dd>
              <span class="status-dot" class:active={status === "streaming" || status === "submitted"}></span>
              {status}
            </dd>
            <dt>Messages</dt>
            <dd>{snapshotMessages.length}</dd>
            <dt>Tool Calls</dt>
            <dd>{allToolCalls.length}</dd>
          </dl>
        </div>

        {#if systemPromptContext}
          <div class="section">
            <h4>System Prompt</h4>
            <dl class="kv-list">
              <dt>Captured</dt>
              <dd class="mono">{new Date(systemPromptContext.timestamp).toLocaleTimeString()}</dd>
              <dt>Parts</dt>
              <dd>{systemPromptContext.systemMessages.length}</dd>
              <dt>Chars</dt>
              <dd>{systemPromptContext.systemMessages.reduce((s, m) => s + m.length, 0).toLocaleString()}</dd>
            </dl>
          </div>
        {/if}

      {:else if activeTab === "tools"}
        {#if usedTools.size === 0}
          <div class="empty">No tool calls in this session.</div>
        {:else}
          <div class="section">
            <h4>Used Tools ({usedTools.size})</h4>
            <ul class="tool-list">
              {#each [...usedTools] as name (name)}
                {@const calls = allToolCalls.filter(tc => tc.toolName === name)}
                {@const ok = calls.filter(tc => tc.state === "output-available").length}
                {@const err = calls.filter(tc => tc.state === "output-error" || tc.state === "output-denied").length}
                <li class="tool-entry">
                  <span class="tool-name">{name}</span>
                  <span class="tool-stats">
                    <span class="stat ok">{ok}✓</span>
                    {#if err > 0}<span class="stat err">{err}✗</span>{/if}
                  </span>
                </li>
              {/each}
            </ul>
          </div>
        {/if}

      {:else if activeTab === "timeline"}
        {#if timeline.length === 0}
          <div class="empty">No activity yet.</div>
        {:else}
          <div class="timeline-list">
            {#each timeline as entry, i (i)}
              <div class="timeline-entry" class:user={entry.type === "user"} class:tool={entry.type === "tool"} class:assistant={entry.type === "assistant"}>
                <span class="timeline-icon">
                  {#if entry.type === "user"}→
                  {:else if entry.type === "tool"}{stateIcon(entry.toolState ?? "")}
                  {:else}←
                  {/if}
                </span>
                <div class="timeline-content">
                  {#if entry.type === "tool"}
                    <span class="timeline-tool-name">{entry.toolName}</span>
                    <span class="timeline-detail">{entry.content}</span>
                  {:else}
                    <span class="timeline-detail">{entry.content}</span>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        {/if}

      {:else if activeTab === "waterfall"}
        {#if waterfallTurns.length === 0}
          <div class="empty">Send a message to see timing data.</div>
        {:else}
          <div class="waterfall">
            {#each waterfallTurns as turn, i (i)}
              <div class="waterfall-turn">
                <div class="waterfall-header">
                  <span class="waterfall-label">{turn.userText}</span>
                  <span class="waterfall-total" class:active={turn.isActive}>{formatMs(turn.totalMs)}</span>
                </div>
                <div class="waterfall-bars">
                  {#each turn.bars as bar, bi (bar.label + bi)}
                    <div
                      class="waterfall-bar"
                      class:done={bar.state === "output-available" || bar.state === "done"}
                      class:error={bar.state === "output-error" || bar.state === "output-denied"}
                      class:running={bar.state === "streaming" || (bar.state !== "output-available" && bar.state !== "output-error" && bar.state !== "output-denied" && bar.state !== "done")}
                      class:waiting={bar.type === "waiting"}
                      title="{bar.label}: {formatMs(bar.durationMs)}"
                    >
                      <div class="bar-fill" style="inline-size: {bar.widthPct}%;"></div>
                      <span class="bar-label">{bar.label}</span>
                      <span class="bar-time">{formatMs(bar.durationMs)}</span>
                    </div>
                  {/each}
                </div>
              </div>
            {/each}
          </div>
        {/if}

      {:else if activeTab === "prompt"}
        {#if systemPromptContext}
          <div class="prompt-viewer">
            {#each systemPromptContext.systemMessages as msg, i (i)}
              <details class="prompt-section" open={i === 0}>
                <summary>Part {i + 1} ({msg.length.toLocaleString()} chars)</summary>
                <pre class="prompt-text">{msg}</pre>
              </details>
            {/each}
          </div>
        {:else}
          <div class="empty">System prompt not captured yet. Send a message first.</div>
        {/if}
      {/if}
    </div>
  </div>
{/if}

<style>
  .inspector {
    background-color: var(--color-surface-2);
    border-inline-start: 1px solid var(--color-border-1);
    display: flex;
    flex-direction: column;
    inline-size: 350px;
    min-inline-size: 350px;
    overflow: hidden;
  }

  .inspector-tabs {
    border-block-end: 1px solid var(--color-border-1);
    display: flex;
    flex-shrink: 0;
    gap: 0;
  }

  .tab {
    align-items: center;
    background: transparent;
    border: none;
    border-block-end: 2px solid transparent;
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    cursor: pointer;
    display: flex;
    flex: 1;
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    gap: var(--size-1);
    justify-content: center;
    padding: var(--size-2-5) var(--size-2);
    transition: color 100ms ease;
  }

  .tab:hover {
    color: var(--color-text);
  }

  .tab.active {
    border-block-end-color: var(--color-primary);
    color: var(--color-text);
  }

  .badge {
    background-color: color-mix(in srgb, var(--color-text), transparent 85%);
    border-radius: var(--radius-round);
    font-size: var(--font-size-0);
    min-inline-size: 18px;
    padding: 1px 5px;
    text-align: center;
  }

  .inspector-body {
    flex: 1;
    overflow-y: auto;
    padding: var(--size-3);
    scrollbar-width: thin;
  }

  .section {
    margin-block-end: var(--size-4);
  }

  .section h4 {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-size: var(--font-size-0);
    font-weight: var(--font-weight-6);
    letter-spacing: 0.06em;
    margin-block-end: var(--size-2);
    text-transform: uppercase;
  }

  .kv-list {
    display: grid;
    gap: var(--size-1) var(--size-3);
    grid-template-columns: auto 1fr;
  }

  .kv-list dt {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-1);
  }

  .kv-list dd {
    font-size: var(--font-size-1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .mono {
    font-family: var(--font-family-mono, ui-monospace, monospace);
  }

  .status-dot {
    background-color: color-mix(in srgb, var(--color-text), transparent 60%);
    block-size: 6px;
    border-radius: 50%;
    display: inline-block;
    inline-size: 6px;
  }

  .status-dot.active {
    animation: pulse 1.5s ease-in-out infinite;
    background-color: var(--color-success);
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  .empty {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-1);
    padding: var(--size-4);
    text-align: center;
  }

  /* Tools tab */
  .tool-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  .tool-entry {
    align-items: center;
    display: flex;
    gap: var(--size-2);
    justify-content: space-between;
  }

  .tool-name {
    font-family: var(--font-family-mono, ui-monospace, monospace);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
  }

  .tool-stats {
    display: flex;
    gap: var(--size-1);
  }

  .stat {
    font-size: var(--font-size-0);
  }

  .stat.ok {
    color: var(--color-success);
  }

  .stat.err {
    color: var(--color-error);
  }

  /* Timeline tab */
  .timeline-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  .timeline-entry {
    align-items: flex-start;
    display: flex;
    font-size: var(--font-size-1);
    gap: var(--size-2);
    padding: var(--size-1) 0;
  }

  .timeline-icon {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    flex-shrink: 0;
    font-family: var(--font-family-mono, ui-monospace, monospace);
    inline-size: 14px;
    text-align: center;
  }

  .timeline-entry.user .timeline-icon {
    color: var(--color-primary);
  }

  .timeline-entry.tool .timeline-icon {
    color: var(--color-info);
  }

  .timeline-content {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-inline-size: 0;
  }

  .timeline-tool-name {
    color: var(--color-text);
    font-family: var(--font-family-mono, ui-monospace, monospace);
    font-weight: var(--font-weight-5);
  }

  .timeline-detail {
    color: color-mix(in srgb, var(--color-text), transparent 35%);
    line-height: 1.4;
    word-break: break-word;
  }

  /* Prompt tab */
  .prompt-viewer {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .prompt-section > summary {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    cursor: pointer;
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    user-select: none;
  }

  /* ─── Waterfall ──────────────────────────────────────────────────────── */

  .waterfall {
    display: flex;
    flex-direction: column;
    gap: var(--size-4);
  }

  .waterfall-turn {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  .waterfall-header {
    align-items: center;
    display: flex;
    justify-content: space-between;
  }

  .waterfall-label {
    color: var(--color-text);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .waterfall-total {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    flex-shrink: 0;
    font-family: var(--font-family-mono, ui-monospace, monospace);
    font-size: var(--font-size-0);
  }

  .waterfall-total.active {
    color: var(--color-info);
    font-weight: var(--font-weight-6);
  }

  .waterfall-bars {
    background-color: light-dark(hsl(220 12% 95%), color-mix(in srgb, var(--color-surface-3), transparent 50%));
    border-radius: var(--radius-1);
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-block-size: 24px;
    padding: 3px;
  }

  .waterfall-bar {
    align-items: center;
    border-radius: 3px;
    display: flex;
    font-size: var(--font-size-0);
    gap: var(--size-1);
    justify-content: space-between;
    overflow: hidden;
    padding: 3px 6px;
    position: relative;
  }

  .bar-fill {
    border-radius: 3px;
    inset: 0;
    min-inline-size: 2px;
    position: absolute;
    z-index: 0;
  }

  .bar-label, .bar-time {
    position: relative;
    z-index: 1;
  }

  .waterfall-bar.done {
    background-color: light-dark(hsl(142 60% 92%), hsl(142 20% 15%));
    color: light-dark(hsl(142 60% 25%), hsl(142 60% 80%));
  }

  .waterfall-bar.done .bar-fill {
    background-color: light-dark(hsl(142 60% 75%), hsl(142 40% 25%));
  }

  .waterfall-bar.running {
    background-color: light-dark(hsl(217 70% 93%), hsl(217 20% 15%));
    color: light-dark(hsl(217 70% 30%), hsl(217 70% 80%));
  }

  .waterfall-bar.running .bar-fill {
    animation: bar-pulse 1.5s ease-in-out infinite;
    background-color: light-dark(hsl(217 70% 78%), hsl(217 40% 30%));
  }

  .waterfall-bar.error {
    background-color: light-dark(hsl(10 70% 93%), hsl(10 20% 15%));
    color: light-dark(hsl(10 70% 30%), hsl(10 70% 80%));
  }

  .waterfall-bar.error .bar-fill {
    background-color: light-dark(hsl(10 70% 80%), hsl(10 40% 25%));
  }

  .waterfall-bar.waiting {
    background-color: light-dark(hsl(38 70% 93%), hsl(38 20% 15%));
    color: light-dark(hsl(38 70% 30%), hsl(38 70% 80%));
  }

  .waterfall-bar.waiting .bar-fill {
    animation: bar-pulse 1.5s ease-in-out infinite;
    background-color: light-dark(hsl(38 70% 78%), hsl(38 40% 25%));
  }

  @keyframes bar-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.6; }
  }

  .bar-label {
    font-family: var(--font-family-mono, ui-monospace, monospace);
    font-weight: var(--font-weight-5);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .bar-time {
    flex-shrink: 0;
    font-family: var(--font-family-mono, ui-monospace, monospace);
    opacity: 0.7;
  }

  .prompt-text {
    background-color: light-dark(hsl(220 12% 97%), color-mix(in srgb, var(--color-surface-1), transparent 30%));
    border-radius: var(--radius-2);
    font-family: var(--font-family-mono, ui-monospace, monospace);
    font-size: var(--font-size-0);
    line-height: 1.5;
    margin-block-start: var(--size-1);
    max-block-size: 400px;
    overflow: auto;
    padding: var(--size-2);
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
