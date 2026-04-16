<script lang="ts">
  import { markdownToHTML } from "@atlas/ui";
  import { tick } from "svelte";
  import type { ChatMessage, ImageDisplay, ScheduleProposal, ToolCallDisplay } from "./types";
  import ScheduleProposalCard from "./schedule-proposal-card.svelte";

  interface Props {
    messages: ChatMessage[];
    onScheduleAction?: (
      action: "confirm" | "cancel",
      messageId: string,
      proposal?: ScheduleProposal,
    ) => void;
  }

  const { messages, onScheduleAction }: Props = $props();

  let containerEl: HTMLDivElement | undefined = $state();

  // Auto-scroll to bottom as new messages or tool updates arrive. We watch
  // both the length of the outer list and the total tool-call count so mid-
  // stream tool activity (no new messages, just updated tool cards on the
  // in-flight assistant message) still triggers scroll.
  const totalToolCallCount = $derived(
    messages.reduce((sum, m) => sum + (m.toolCalls?.length ?? 0), 0),
  );

  async function scrollToBottom() {
    await tick();
    if (containerEl) {
      containerEl.scrollTop = containerEl.scrollHeight;
    }
  }

  $effect(() => {
    // deps: messages.length, totalToolCallCount
    const _len = messages.length;
    const _calls = totalToolCallCount;
    void scrollToBottom();
  });

  /**
   * Is this tool call still running? Covers the two in-progress states the
   * AI SDK v6 stream processor emits before the final `output-available`
   * or `output-error`.
   */
  function isInProgress(state: ToolCallDisplay["state"]): boolean {
    return state === "input-streaming" || state === "input-available";
  }

  function isError(state: ToolCallDisplay["state"]): boolean {
    return state === "output-error" || state === "output-denied";
  }

  /**
   * Render a tool's input arguments as a short one-liner for the tool
   * card label. Picks the most informative field per tool so the user
   * sees "web_fetch(blizzard.com)" instead of "web_fetch" or a full JSON
   * dump. Unknown tools fall back to the first string-valued arg.
   */
  function argPreview(toolName: string, input: unknown): string {
    if (typeof input !== "object" || input === null) return "";
    const obj = input as Record<string, unknown>;
    if (toolName === "web_fetch" && typeof obj.url === "string") {
      try {
        return new URL(obj.url).hostname;
      } catch {
        return obj.url.slice(0, 40);
      }
    }
    if (toolName === "web_search" && typeof obj.query === "string") {
      return obj.query.slice(0, 60);
    }
    if (toolName === "run_code" && typeof obj.language === "string") {
      return String(obj.language);
    }
    if (
      (toolName === "read_file" || toolName === "write_file" || toolName === "list_files") &&
      typeof obj.path === "string"
    ) {
      return obj.path;
    }
    if (toolName === "do_task" && typeof obj.intent === "string") {
      return obj.intent.length > 60 ? `${obj.intent.slice(0, 60)}…` : obj.intent;
    }
    if (toolName === "load_skill" && typeof obj.name === "string") {
      return obj.name;
    }
    if (toolName === "memory_save" && typeof obj.text === "string") {
      return obj.text.length > 60 ? `${obj.text.slice(0, 60)}…` : obj.text;
    }
    // Generic fallback — first string value.
    for (const v of Object.values(obj)) {
      if (typeof v === "string" && v.length > 0) {
        return v.length > 60 ? `${v.slice(0, 60)}…` : v;
      }
    }
    return "";
  }

  /**
   * Short, user-facing description of what a tool did once it finished.
   * Summarizes the most useful field per tool. Detailed output stays in
   * the `<details>` drawer for on-demand inspection.
   */
  function outputSummary(toolName: string, output: unknown): string {
    if (typeof output !== "object" || output === null) return "";
    const obj = output as Record<string, unknown>;
    // Error shape — every tool returns { error: string } on failure.
    if (typeof obj.error === "string") return obj.error;
    if (toolName === "web_fetch") {
      const url = typeof obj.sourceUrl === "string" ? obj.sourceUrl : "";
      const fromCache = obj.fromCache === true ? " (cached)" : "";
      if (url) {
        try {
          return `${new URL(url).hostname}${fromCache}`;
        } catch {
          return `${url.slice(0, 40)}${fromCache}`;
        }
      }
    }
    if (toolName === "web_search" && Array.isArray(obj.results)) {
      return `${obj.results.length} result${obj.results.length === 1 ? "" : "s"}`;
    }
    if (toolName === "run_code" && typeof obj.duration_ms === "number") {
      const exitCode = typeof obj.exit_code === "number" ? obj.exit_code : 0;
      return exitCode === 0
        ? `exit 0 · ${obj.duration_ms} ms`
        : `exit ${exitCode} · ${obj.duration_ms} ms`;
    }
    if (toolName === "read_file" && typeof obj.size_bytes === "number") {
      return `${obj.size_bytes} bytes`;
    }
    if (toolName === "write_file" && typeof obj.bytes_written === "number") {
      return `${obj.bytes_written} bytes written`;
    }
    if (toolName === "list_files" && Array.isArray(obj.entries)) {
      return `${obj.entries.length} entr${obj.entries.length === 1 ? "y" : "ies"}`;
    }
    return "done";
  }

  /** Formatter for the collapsible raw output. Handles strings + JSON. */
  function formatRawOutput(output: unknown): string {
    if (typeof output === "string") {
      // Try to parse as JSON for pretty-printing (web_fetch returns JSON strings)
      try {
        const parsed: unknown = JSON.parse(output);
        return JSON.stringify(parsed, null, 2);
      } catch {
        return output;
      }
    }
    try {
      return JSON.stringify(output, null, 2);
    } catch {
      return String(output);
    }
  }
</script>

<div class="message-list" bind:this={containerEl}>
  {#each messages as message (message.id)}
    {#if message.scheduleProposal}
      <div class="message system" style="align-self: center; max-inline-size: 90%;">
        <ScheduleProposalCard
          proposal={message.scheduleProposal}
          onconfirm={(p) => onScheduleAction?.("confirm", message.id, p)}
          oncancel={() => onScheduleAction?.("cancel", message.id)}
        />
      </div>
    {:else}
      <div
        class="message"
        class:user={message.role === "user"}
        class:assistant={message.role === "assistant"}
        class:system={message.role === "system"}
      >
        {#if message.role === "system"}
          <div class="message-content system-content">{message.content}</div>
        {:else}
          <span class="role-badge">{message.role === "user" ? "You" : "Friday"}</span>

          {#if message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0}
            <div class="tool-call-list">
              {#each message.toolCalls as call (call.toolCallId || call.toolName)}
                <div
                  class="tool-card"
                  class:in-progress={isInProgress(call.state)}
                  class:error={isError(call.state)}
                >
                  <div class="tool-card-header">
                    <span class="tool-card-icon" aria-hidden="true">
                      {#if isInProgress(call.state)}
                        <span class="spinner"></span>
                      {:else if isError(call.state)}
                        ✗
                      {:else}
                        ✓
                      {/if}
                    </span>
                    <span class="tool-card-name">{call.toolName}</span>
                    <span class="tool-card-arg">{argPreview(call.toolName, call.input)}</span>
                    <span class="tool-card-status">
                      {#if isInProgress(call.state)}
                        running…
                      {:else if call.state === "output-available"}
                        {outputSummary(call.toolName, call.output)}
                      {:else if call.state === "output-error"}
                        {call.errorText ?? "failed"}
                      {:else if call.state === "output-denied"}
                        denied
                      {:else if call.state === "approval-requested"}
                        needs approval
                      {:else}
                        {call.state}
                      {/if}
                    </span>
                  </div>
                  {#if call.state === "output-available" && call.output !== undefined}
                    <details class="tool-card-details">
                      <summary>details</summary>
                      <pre>{formatRawOutput(call.output)}</pre>
                    </details>
                  {:else if call.state === "output-error" && call.input !== undefined}
                    <details class="tool-card-details">
                      <summary>input</summary>
                      <pre>{formatRawOutput(call.input)}</pre>
                    </details>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}

          {#if message.images && message.images.length > 0}
            <div class="message-images">
              {#each message.images as img}
                <img src={img.url} alt={img.filename ?? "attached image"} class="chat-image" />
              {/each}
            </div>
          {/if}

          {#if message.content.length > 0}
            {#if message.role === "assistant"}
              <div class="message-content markdown-body">{@html markdownToHTML(message.content)}</div>
            {:else}
              <div class="message-content">{message.content}</div>
            {/if}
          {/if}
        {/if}
      </div>
    {/if}
  {/each}

  {#if messages.length === 0}
    <div class="empty-state">
      <p>Send a message to start a conversation.</p>
      <p class="hint">
        Friday can search the web, run Python or bash, and read or write files in an ephemeral
        per-chat scratch directory. Try asking for something time-sensitive or computational.
      </p>
    </div>
  {/if}
</div>

<style>
  .message-list {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--size-4);
    overflow-y: auto;
    padding: var(--size-4);
    scrollbar-width: thin;
  }

  .message {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
    max-inline-size: 80%;
  }

  .message.user {
    align-self: flex-end;
  }

  .message.assistant {
    align-self: flex-start;
  }

  .role-badge {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .message-content {
    background-color: var(--color-surface-3);
    border-radius: var(--radius-3);
    font-size: var(--font-size-2);
    line-height: 1.55;
    padding: var(--size-2-5) var(--size-3);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .message-content.markdown-body {
    white-space: normal;
  }

  .message-content.markdown-body :global(p) {
    margin-block: 0.4em;
  }

  .message-content.markdown-body :global(p:first-child) {
    margin-block-start: 0;
  }

  .message-content.markdown-body :global(p:last-child) {
    margin-block-end: 0;
  }

  .message-content.markdown-body :global(ul),
  .message-content.markdown-body :global(ol) {
    margin-block: 0.4em;
    padding-inline-start: 1.4em;
  }

  .message-content.markdown-body :global(li) {
    margin-block: 0.15em;
  }

  .message-content.markdown-body :global(code) {
    background-color: light-dark(hsl(220 16% 90%), hsl(228 4% 22%));
    border-radius: var(--radius-1);
    font-family: var(--font-family-mono, ui-monospace, monospace);
    font-size: 0.9em;
    padding: 0.1em 0.35em;
  }

  .message-content.markdown-body :global(pre) {
    background-color: light-dark(hsl(220 16% 90%), hsl(228 4% 12%));
    border-radius: var(--radius-2);
    margin-block: 0.5em;
    overflow-x: auto;
    padding: var(--size-2);
  }

  .message-content.markdown-body :global(pre code) {
    background-color: transparent;
    font-size: var(--font-size-1);
    padding: 0;
  }

  .message-content.markdown-body :global(strong) {
    font-weight: var(--font-weight-6);
  }

  .message-content.markdown-body :global(h1),
  .message-content.markdown-body :global(h2),
  .message-content.markdown-body :global(h3),
  .message-content.markdown-body :global(h4) {
    font-weight: var(--font-weight-6);
    margin-block: 0.6em 0.3em;
  }

  .message-content.markdown-body :global(h1) { font-size: 1.2em; }
  .message-content.markdown-body :global(h2) { font-size: 1.1em; }
  .message-content.markdown-body :global(h3) { font-size: 1.05em; }

  .message-content.markdown-body :global(table) {
    border-collapse: collapse;
    font-size: var(--font-size-1);
    margin-block: 0.5em;
    inline-size: 100%;
  }

  .message-content.markdown-body :global(th),
  .message-content.markdown-body :global(td) {
    border: 1px solid var(--color-border-1);
    padding: var(--size-1) var(--size-2);
    text-align: start;
  }

  .message-content.markdown-body :global(th) {
    font-weight: var(--font-weight-6);
  }

  .message-content.markdown-body :global(blockquote) {
    border-inline-start: 3px solid var(--color-border-1);
    color: light-dark(hsl(220 10% 40%), color-mix(in srgb, var(--color-text), transparent 25%));
    margin-block: 0.4em;
    margin-inline: 0;
    padding-inline-start: var(--size-3);
  }

  .message-content.markdown-body :global(a) {
    color: var(--color-primary);
    text-decoration: underline;
  }

  .message.user .message-content {
    background-color: var(--color-primary);
    color: white;
  }

  .message.system {
    align-self: center;
    max-inline-size: 90%;
  }

  .system-content {
    background-color: light-dark(hsl(217 80% 95%), color-mix(in srgb, var(--color-info), transparent 85%));
    border: 1px solid light-dark(hsl(217 60% 85%), color-mix(in srgb, var(--color-info), transparent 70%));
    color: light-dark(hsl(217 30% 35%), color-mix(in srgb, var(--color-text), transparent 20%));
    font-size: var(--font-size-1);
    font-style: italic;
    text-align: center;
  }

  /* ─── Tool-call cards ───────────────────────────────────────────────── */

  .tool-call-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  .tool-card {
    background-color: light-dark(hsl(220 16% 95%), color-mix(in srgb, var(--color-surface-3), transparent 30%));
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    font-size: var(--font-size-1);
    padding: var(--size-1-5) var(--size-2-5);
  }

  .tool-card.in-progress {
    border-color: light-dark(hsl(217 80% 70%), color-mix(in srgb, var(--color-info), transparent 50%));
    background-color: light-dark(hsl(217 80% 95%), color-mix(in srgb, var(--color-info), transparent 90%));
  }

  .tool-card.error {
    border-color: light-dark(hsl(10 80% 70%), color-mix(in srgb, var(--color-error), transparent 50%));
    background-color: light-dark(hsl(10 80% 95%), color-mix(in srgb, var(--color-error), transparent 90%));
  }

  .tool-card-header {
    align-items: center;
    display: flex;
    gap: var(--size-2);
    min-inline-size: 0;
  }

  .tool-card-icon {
    display: inline-flex;
    flex-shrink: 0;
    inline-size: 14px;
    justify-content: center;
  }

  .tool-card-name {
    color: var(--color-text);
    flex-shrink: 0;
    font-family: var(--font-family-mono, ui-monospace, monospace);
    font-weight: var(--font-weight-5);
  }

  .tool-card-arg {
    color: light-dark(hsl(220 10% 40%), color-mix(in srgb, var(--color-text), transparent 35%));
    flex-shrink: 0;
    font-family: var(--font-family-mono, ui-monospace, monospace);
    max-inline-size: 40ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tool-card-status {
    color: light-dark(hsl(220 10% 45%), color-mix(in srgb, var(--color-text), transparent 45%));
    flex: 1;
    font-style: italic;
    min-inline-size: 0;
    overflow: hidden;
    text-align: end;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tool-card-details {
    margin-block-start: var(--size-1-5);
  }

  .tool-card-details > summary {
    color: light-dark(hsl(220 10% 50%), color-mix(in srgb, var(--color-text), transparent 50%));
    cursor: pointer;
    font-size: var(--font-size-0, 11px);
    user-select: none;
  }

  .tool-card-details > pre {
    background-color: light-dark(hsl(220 12% 97%), color-mix(in srgb, var(--color-surface-2), transparent 30%));
    border-radius: var(--radius-1);
    font-family: var(--font-family-mono, ui-monospace, monospace);
    font-size: var(--font-size-0, 11px);
    margin-block-start: var(--size-1);
    max-block-size: 400px;
    overflow: auto;
    padding: var(--size-2);
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* ─── Spinner ───────────────────────────────────────────────────────── */

  .spinner {
    animation: tool-spin 0.8s linear infinite;
    border: 2px solid light-dark(hsl(217 60% 80%), color-mix(in srgb, var(--color-info), transparent 60%));
    border-block-start-color: var(--color-info);
    border-radius: 50%;
    display: inline-block;
    inline-size: 10px;
    block-size: 10px;
  }

  @keyframes tool-spin {
    to {
      transform: rotate(360deg);
    }
  }

  /* ─── Inline images ─────────────────────────────────────────────────── */

  .message-images {
    display: flex;
    flex-wrap: wrap;
    gap: var(--size-2);
  }

  .chat-image {
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    display: block;
    max-block-size: 300px;
    max-inline-size: 100%;
    object-fit: contain;
  }

  /* ─── Empty state ───────────────────────────────────────────────────── */

  .empty-state {
    align-items: center;
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--size-2);
    justify-content: center;
    text-align: center;
  }

  .empty-state p {
    font-size: var(--font-size-3);
  }

  .empty-state .hint {
    font-size: var(--font-size-1);
    max-inline-size: 400px;
  }
</style>
