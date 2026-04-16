<script lang="ts">
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

  let activeTab: "context" | "tools" | "timeline" | "prompt" = $state("context");

  /** All unique tool names used across all assistant messages. */
  const usedTools = $derived.by(() => {
    const names = new Set<string>();
    for (const msg of messages) {
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
    const calls: Array<ToolCallDisplay & { messageId: string }> = [];
    for (const msg of messages) {
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
    const entries: Array<{
      type: "user" | "assistant" | "tool";
      timestamp: number;
      content: string;
      toolName?: string;
      toolState?: string;
      duration?: string;
    }> = [];
    for (const msg of messages) {
      if (msg.role === "user") {
        entries.push({
          type: "user",
          timestamp: msg.timestamp,
          content: msg.content.slice(0, 80) + (msg.content.length > 80 ? "..." : ""),
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
            content: msg.content.slice(0, 80) + (msg.content.length > 80 ? "..." : ""),
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
            <dd>{messages.length}</dd>
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
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
