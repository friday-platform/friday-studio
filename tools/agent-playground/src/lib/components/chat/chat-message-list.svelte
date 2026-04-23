<script lang="ts">
  import { DropdownMenu, markdownToHTML } from "@atlas/ui";
  import { tick } from "svelte";
  import { jsonHighlighter } from "./json-highlighter";
  import type { ChatMessage, ImageDisplay, ScheduleProposal, ToolCallDisplay } from "./types";
  import ScheduleProposalCard from "./schedule-proposal-card.svelte";

  // Message timestamp for the per-message "…" menu.
  //   • same calendar day → "Today, 12:31 PM"
  //   • any other day     → "Apr 20, 11:31 PM"
  const TIME_FMT = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  const DATETIME_FMT = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  function formatMessageTimestamp(timestamp: number): string {
    const date = new Date(timestamp);
    const now = new Date();
    const sameDay =
      date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth() &&
      date.getDate() === now.getDate();
    if (sameDay) return `Today, ${TIME_FMT.format(date)}`;
    return DATETIME_FMT.format(date);
  }

  interface Props {
    messages: ChatMessage[];
    onScheduleAction?: (
      action: "confirm" | "cancel",
      messageId: string,
      proposal?: ScheduleProposal,
    ) => void;
    /**
     * When true, renders a placeholder assistant bubble with animated
     * dots at the bottom of the list — for the "submitted, no response
     * yet" window. Parent hides this as soon as the real assistant
     * message starts producing text or tool-call content.
     */
    thinking?: boolean;
  }

  const { messages, onScheduleAction, thinking = false }: Props = $props();

  let containerEl: HTMLDivElement | undefined = $state();

  // Auto-scroll to bottom as new messages or tool updates arrive. We watch
  // both the length of the outer list and the total tool-call count so mid-
  // stream tool activity (no new messages, just updated tool cards on the
  // in-flight assistant message) still triggers scroll.
  const totalToolCallCount = $derived(
    messages.reduce((sum, m) => sum + (m.toolCalls?.length ?? 0), 0),
  );

  // "Sticky-follow" state: true while the viewport is anchored at/near the
  // bottom, false the moment the user scrolls up to read history. Without
  // this, every streaming token would re-snap the scroll to the bottom and
  // the user couldn't review earlier messages mid-generation.
  //
  // A small threshold (not just === 0) tolerates subpixel rounding and the
  // half-line of inertia after a fast wheel scroll that settles just above
  // the bottom — we want "basically at the bottom" to still count as
  // following.
  const STICK_THRESHOLD_PX = 80;
  let followBottom = $state(true);

  function handleScroll() {
    if (!containerEl) return;
    const distanceFromBottom =
      containerEl.scrollHeight - containerEl.scrollTop - containerEl.clientHeight;
    followBottom = distanceFromBottom < STICK_THRESHOLD_PX;
  }

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
    // Only scroll if the user is still anchored at the bottom. If they
    // scrolled up to read history, honor that — otherwise we'd hijack
    // their position every token and the chat would be unreadable during
    // generation. Re-enabling follow is implicit: when they scroll back
    // to the bottom, `handleScroll` flips `followBottom` to true.
    if (followBottom) {
      void scrollToBottom();
    }
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

  /** Threshold above which multi-tool runs collapse into a summary block. */
  const COLLAPSE_THRESHOLD = 3;

  /**
   * Per-message latch: once the user clicks the drawer summary, record their
   * choice and stop syncing `open` from `anyRunning`. Without this, Svelte
   * re-writes `open={false}` when the last tool finishes — slamming the
   * drawer shut while the user is reading individual cards.
   */
  let userToggledGroups: Map<string, boolean> = $state(new Map());

  function handleGroupToggleClick(e: MouseEvent, messageId: string, anyRunning: boolean) {
    // Take over the default <summary> click. We manage `open` via the
    // `userToggledGroups` latch; flipping the current effective state here
    // keeps the animation in sync without the browser fighting Svelte's
    // reactive `open` attribute on the next anyRunning tick.
    e.preventDefault();
    const prev = userToggledGroups.get(messageId);
    const currentOpen = prev ?? anyRunning;
    const next = new Map(userToggledGroups);
    next.set(messageId, !currentOpen);
    userToggledGroups = next;
  }

  /**
   * Per-delegate latch keyed by the delegate's `toolCallId`. Mirrors the
   * `userToggledGroups` pattern but scoped to a single delegate card so
   * one delegate's toggle doesn't affect a sibling delegate in the same
   * message. Without this, the auto-collapse-when-children-finish behavior
   * would steamroll a user who manually expanded a completed delegate to
   * inspect what its sub-agent did.
   */
  let userToggledDelegates: Map<string, boolean> = $state(new Map());

  function handleDelegateToggleClick(
    e: MouseEvent,
    delegateToolCallId: string,
    childrenRunning: boolean,
  ) {
    e.preventDefault();
    const prev = userToggledDelegates.get(delegateToolCallId);
    const currentOpen = prev ?? childrenRunning;
    const next = new Map(userToggledDelegates);
    next.set(delegateToolCallId, !currentOpen);
    userToggledDelegates = next;
  }

  /**
   * True iff any reconstructed delegate child is still mid-execution.
   * Drives the auto-expand behavior on a delegate `<details>` — open
   * while any child is running, collapse once they all settle.
   */
  function childrenAnyRunning(children: ToolCallDisplay[]): boolean {
    return children.some((c) => isInProgress(c.state));
  }

  /**
   * Build a short summary for a collapsed tool-call group. Surfaces the
   * total, any errors or running calls, and the most recent tool name so
   * the user knows at a glance what happened without expanding.
   */
  function toolGroupSummary(calls: ToolCallDisplay[]): string {
    const running = calls.filter((c) => isInProgress(c.state)).length;
    const errored = calls.filter((c) => isError(c.state)).length;
    const lastName = calls.at(-1)?.toolName ?? "";
    const parts: string[] = [`${calls.length} tool calls`];
    if (running > 0) parts.push(`${running} running`);
    if (errored > 0) parts.push(`${errored} failed`);
    if (lastName) parts.push(`last: ${lastName}`);
    return parts.join(" · ");
  }

  /**
   * Svelte action: inject a "Copy" button on every <pre> and <table> inside
   * a `.markdown-body` container. Runs after initial render and re-scans
   * when the DOM subtree changes (streaming content).
   */
  function copyButtons(node: HTMLElement) {
    function injectButtons() {
      for (const el of node.querySelectorAll("pre, table")) {
        // Skip if already wrapped
        if (el.parentElement?.classList.contains("copyable-wrapper")) continue;

        const wrapper = document.createElement("div");
        wrapper.className = "copyable-wrapper";
        el.parentNode?.insertBefore(wrapper, el);
        wrapper.appendChild(el);

        const btn = document.createElement("button");
        btn.className = "copy-btn";
        btn.setAttribute("aria-label", "Copy to clipboard");
        btn.textContent = "Copy";
        btn.addEventListener("click", () => {
          let text: string;
          if (el.tagName === "TABLE") {
            // Extract table as tab-separated text
            const rows: string[] = [];
            for (const tr of el.querySelectorAll("tr")) {
              const cells: string[] = [];
              for (const cell of tr.querySelectorAll("th, td")) {
                cells.push((cell as HTMLElement).textContent?.trim() ?? "");
              }
              rows.push(cells.join("\t"));
            }
            text = rows.join("\n");
          } else {
            text = (el as HTMLElement).textContent ?? "";
          }
          void navigator.clipboard.writeText(text).then(() => {
            btn.textContent = "Copied!";
            setTimeout(() => { btn.textContent = "Copy"; }, 1500);
          });
        });
        wrapper.appendChild(btn);
      }
    }

    injectButtons();

    const observer = new MutationObserver(() => injectButtons());
    observer.observe(node, { childList: true, subtree: true });

    return {
      destroy() {
        observer.disconnect();
      },
    };
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
    if (toolName === "delegate" && typeof obj.goal === "string") {
      return obj.goal.length > 60 ? `${obj.goal.slice(0, 60)}…` : obj.goal;
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
  /** Pretty-print and syntax-highlight JSON for the details panel. */
  function formatRawOutput(output: unknown): string {
    let jsonStr: string;
    if (typeof output === "string") {
      try {
        const parsed: unknown = JSON.parse(output);
        jsonStr = JSON.stringify(parsed, null, 2);
      } catch {
        return output.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      }
    } else {
      try {
        jsonStr = JSON.stringify(output, null, 2);
      } catch {
        return String(output).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      }
    }
    return jsonHighlighter.codeToHtml(jsonStr, { lang: "json", theme: "atlas-json" });
  }
</script>

<!--
  Single-card render for a tool call. Extracted so the two surrounding
  branches (collapsed group vs inline list) can share the same body
  without duplication. Recurses into `call.children` for delegate cards
  so a delegate's reconstructed sub-agent tool calls render nested
  beneath its header.
-->
{#snippet toolCardHeaderContent(call: ToolCallDisplay)}
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
{/snippet}

{#snippet toolCardOutputDrawer(call: ToolCallDisplay)}
  {#if call.state === "output-available" && call.output !== undefined}
    <details class="tool-card-details">
      <summary>details</summary>
      <pre>{@html formatRawOutput(call.output)}</pre>
    </details>
  {:else if call.state === "output-error" && call.input !== undefined}
    <details class="tool-card-details">
      <summary>input</summary>
      <pre>{@html formatRawOutput(call.input)}</pre>
    </details>
  {/if}
{/snippet}

{#snippet toolCard(call: ToolCallDisplay)}
  {#if call.children && call.children.length > 0}
    <!--
      Delegate card: wrap the header in <summary> so clicking it toggles
      visibility of the reconstructed children. Auto-expand while any child
      is running so the user can watch sub-agent progress live; collapse
      once all children settle. `userToggledDelegates` latches a manual
      click so the auto-collapse on completion doesn't slam the drawer
      shut while the user is reading.
    -->
    {@const childrenRunning = childrenAnyRunning(call.children)}
    {@const userChoice = userToggledDelegates.get(call.toolCallId)}
    {@const isOpen = userChoice ?? childrenRunning}
    <details
      class="tool-card with-children"
      class:in-progress={isInProgress(call.state)}
      class:error={isError(call.state)}
      open={isOpen}
    >
      <summary
        class="tool-card-header"
        onclick={(e) => handleDelegateToggleClick(e, call.toolCallId, childrenRunning)}
      >
        {@render toolCardHeaderContent(call)}
      </summary>
      <div class="tool-call-children">
        {#each call.children as child (child.toolCallId || child.toolName)}
          {@render toolCard(child)}
        {/each}
      </div>
      {@render toolCardOutputDrawer(call)}
    </details>
  {:else}
    <div
      class="tool-card"
      class:in-progress={isInProgress(call.state)}
      class:error={isError(call.state)}
    >
      <div class="tool-card-header">
        {@render toolCardHeaderContent(call)}
      </div>
      {@render toolCardOutputDrawer(call)}
    </div>
  {/if}
{/snippet}

<div class="message-list" bind:this={containerEl} onscroll={handleScroll}>
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
            {@const calls = message.toolCalls}
            {@const anyRunning = calls.some((c) => isInProgress(c.state))}
            {#if calls.length >= COLLAPSE_THRESHOLD}
              <!--
                Long tool runs (workspace creation, etc.) clutter the thread
                when every step renders inline. Collapse into a single-line
                summary that auto-opens while any call is running (so live
                progress is always visible) and closes once the run settles
                — unless the user has manually toggled the drawer, in which
                case their choice is latched via `userToggledGroups`.
              -->
              {@const userChoice = userToggledGroups.get(message.id)}
              {@const isOpen = userChoice ?? anyRunning}
              <details class="tool-call-group" open={isOpen}>
                <summary
                  class="tool-call-group-summary"
                  onclick={(e) => handleGroupToggleClick(e, message.id, anyRunning)}
                >
                  <span class="tool-card-icon" aria-hidden="true">
                    {#if anyRunning}
                      <span class="spinner"></span>
                    {:else if calls.some((c) => isError(c.state))}
                      ✗
                    {:else}
                      ✓
                    {/if}
                  </span>
                  <span class="tool-group-label">{toolGroupSummary(calls)}</span>
                </summary>
                <div class="tool-call-list">
                  {#each calls as call (call.toolCallId || call.toolName)}
                    {@render toolCard(call)}
                  {/each}
                </div>
              </details>
            {:else}
              <div class="tool-call-list">
                {#each calls as call (call.toolCallId || call.toolName)}
                  {@render toolCard(call)}
                {/each}
              </div>
            {/if}
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
              <div class="message-content markdown-body" use:copyButtons>{@html markdownToHTML(message.content)}</div>
            {:else}
              <div class="message-content">{message.content}</div>
            {/if}
          {/if}

          {#if message.errorText}
            <!-- Session failure bubble: the turn errored before producing any
                 text or tool output. Without this, the thinking indicator
                 vanishes silently on failures like "no such column: job_name"
                 and the user has no way to tell the request failed. -->
            <div class="message-error" role="alert" aria-live="assertive">
              <span class="message-error-icon" aria-hidden="true">⚠</span>
              <div class="message-error-body">
                <div class="message-error-title">Something went wrong.</div>
                <div class="message-error-detail">{message.errorText}</div>
              </div>
            </div>
          {/if}

          <!-- Per-message overflow menu. Holds the timestamp today; later
               actions (branch, read aloud, copy, etc.) hang off the same
               Content. User/assistant only — system messages stay quiet. -->
          <div class="message-actions">
            <DropdownMenu.Root positioning={{ placement: "bottom-start" }}>
              {#snippet children()}
                <DropdownMenu.Trigger class="message-menu-trigger" aria-label="Message options">
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 16 16"
                    fill="none"
                    aria-hidden="true"
                  >
                    <circle cx="4" cy="8" r="1.25" fill="currentColor" />
                    <circle cx="8" cy="8" r="1.25" fill="currentColor" />
                    <circle cx="12" cy="8" r="1.25" fill="currentColor" />
                  </svg>
                </DropdownMenu.Trigger>
                <DropdownMenu.Content>
                  <DropdownMenu.Label>
                    {formatMessageTimestamp(message.timestamp)}
                  </DropdownMenu.Label>
                </DropdownMenu.Content>
              {/snippet}
            </DropdownMenu.Root>
          </div>
        {/if}
      </div>
    {/if}
  {/each}

  {#if thinking}
    <!-- Placeholder assistant bubble shown between send and first-token.
         Replaced in-place by the real assistant message as soon as text
         or a tool-call arrives. Same layout as .message.assistant so
         there's no visual jump when the swap happens. -->
    <div class="message assistant thinking-bubble" role="status" aria-live="polite">
      <span class="role-badge">Friday</span>
      <div class="message-content thinking-content">
        <span class="thinking-dots" aria-hidden="true">
          <span></span><span></span><span></span>
        </span>
        <span class="thinking-label">Thinking…</span>
      </div>
    </div>
  {/if}

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

  /* Per-message overflow menu. Sits just below the bubble, dims until
     the row is hovered so it doesn't compete with message content. */
  .message-actions {
    display: flex;
    gap: var(--size-1);
    opacity: 0.45;
    padding-block-start: 2px;
    transition: opacity 120ms ease;
  }
  .message:hover .message-actions,
  .message-actions:focus-within {
    opacity: 1;
  }
  .message.user .message-actions {
    justify-content: flex-end;
  }

  .message-actions :global(.message-menu-trigger) {
    align-items: center;
    background: transparent;
    border: none;
    border-radius: var(--radius-1);
    color: color-mix(in srgb, var(--color-text), transparent 35%);
    cursor: pointer;
    display: inline-flex;
    inline-size: 24px;
    block-size: 20px;
    justify-content: center;
    padding: 0;
    transition: background-color 120ms ease, color 120ms ease;
  }
  .message-actions :global(.message-menu-trigger:hover),
  .message-actions :global(.message-menu-trigger[data-state="open"]) {
    background: color-mix(in srgb, var(--color-text), transparent 92%);
    color: var(--color-text);
  }

  /* Thinking placeholder — same footprint as a real assistant bubble so
     swapping it for the real message doesn't visually jump. */
  .thinking-content {
    align-items: center;
    color: color-mix(in srgb, var(--color-text), transparent 35%);
    display: inline-flex;
    font-style: italic;
    gap: var(--size-2);
  }
  .thinking-dots {
    display: inline-flex;
    gap: 3px;
  }
  .thinking-dots span {
    animation: msg-thinking-bounce 1.2s infinite ease-in-out;
    background: currentColor;
    block-size: 5px;
    border-radius: 50%;
    display: inline-block;
    inline-size: 5px;
  }
  .thinking-dots span:nth-child(2) { animation-delay: 0.15s; }
  .thinking-dots span:nth-child(3) { animation-delay: 0.3s; }

  @keyframes msg-thinking-bounce {
    0%, 60%, 100% { opacity: 0.25; transform: translateY(0); }
    30% { opacity: 1; transform: translateY(-3px); }
  }

  @media (prefers-reduced-motion: reduce) {
    .thinking-dots span { animation: none; opacity: 0.7; }
  }

  .role-badge {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .message-error {
    align-items: flex-start;
    background-color: light-dark(#fef2f2, color-mix(in srgb, #dc2626, black 70%));
    border: 1px solid light-dark(#fecaca, color-mix(in srgb, #dc2626, black 40%));
    border-radius: var(--radius-3);
    color: light-dark(#991b1b, #fecaca);
    display: flex;
    font-size: var(--font-size-2);
    gap: var(--size-2);
    line-height: 1.5;
    padding: var(--size-2-5) var(--size-3);
  }
  .message-error-icon {
    flex-shrink: 0;
    font-size: 1.1em;
  }
  .message-error-body {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-inline-size: 0;
  }
  .message-error-title {
    font-weight: var(--font-weight-6);
  }
  .message-error-detail {
    font-family: var(--font-mono);
    font-size: var(--font-size-1);
    opacity: 0.85;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
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
    max-inline-size: 100%;
    overflow-x: auto;
  }

  .message-content.markdown-body :global(th),
  .message-content.markdown-body :global(td) {
    border: 1px solid var(--color-border-1);
    padding: var(--size-1) var(--size-2);
    text-align: start;
    white-space: nowrap;
  }

  .message-content.markdown-body :global(th) {
    background-color: light-dark(hsl(220 12% 94%), color-mix(in srgb, var(--color-surface-3), transparent 30%));
    font-weight: var(--font-weight-6);
  }

  .message-content.markdown-body :global(tr:nth-child(even) td) {
    background-color: light-dark(hsl(220 12% 97%), color-mix(in srgb, var(--color-surface-2), transparent 50%));
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

  /* Copy button on code blocks and tables */
  .message-content.markdown-body :global(.copyable-wrapper) {
    position: relative;
  }

  .message-content.markdown-body :global(.copy-btn) {
    background-color: light-dark(hsl(220 12% 88%), hsl(220 10% 22%));
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-1);
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    cursor: pointer;
    font-family: inherit;
    font-size: 11px;
    inset-block-start: var(--size-1);
    inset-inline-end: var(--size-1);
    opacity: 0;
    padding: 2px 8px;
    position: absolute;
    transition: opacity 100ms ease, color 100ms ease, background-color 100ms ease;
    z-index: 1;
  }

  .message-content.markdown-body :global(.copyable-wrapper:hover .copy-btn) {
    opacity: 1;
  }

  .message-content.markdown-body :global(.copy-btn:hover) {
    background-color: light-dark(hsl(220 12% 82%), hsl(220 10% 28%));
    color: var(--color-text);
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

  /* Collapsible group wrapper (shown when a message has ≥ 3 tool calls). */
  .tool-call-group {
    background-color: light-dark(hsl(220 16% 95%), color-mix(in srgb, var(--color-surface-3), transparent 30%));
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
  }

  .tool-call-group[open] {
    padding-block-end: var(--size-1-5);
  }

  .tool-call-group-summary {
    align-items: center;
    color: var(--color-text);
    cursor: pointer;
    display: flex;
    font-size: var(--font-size-1);
    gap: var(--size-2);
    list-style: none;
    padding: var(--size-1-5) var(--size-2-5);
    user-select: none;
  }

  .tool-call-group-summary::-webkit-details-marker {
    display: none;
  }

  .tool-call-group-summary::before {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    content: "▸";
    flex-shrink: 0;
    font-size: 10px;
    transition: transform 100ms ease;
  }

  .tool-call-group[open] > .tool-call-group-summary::before {
    transform: rotate(90deg);
  }

  .tool-group-label {
    color: light-dark(hsl(220 10% 40%), color-mix(in srgb, var(--color-text), transparent 30%));
    font-family: var(--font-family-mono, ui-monospace, monospace);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* When nested inside the group, remove redundant outer card styles. */
  .tool-call-group[open] > .tool-call-list {
    border-block-start: 1px solid var(--color-border-1);
    padding: var(--size-1-5);
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

  /* Delegate cards reuse `.tool-card` chrome but render as a <details> so
     their reconstructed children can be folded/expanded under the header. */
  .tool-card.with-children {
    padding: 0;
  }

  .tool-card.with-children > summary.tool-card-header {
    cursor: pointer;
    list-style: none;
    padding: var(--size-1-5) var(--size-2-5);
    user-select: none;
  }

  .tool-card.with-children > summary.tool-card-header::-webkit-details-marker {
    display: none;
  }

  /* Disclosure caret matches the `.tool-call-group-summary` pattern so the
     two collapsible affordances feel like the same control. */
  .tool-card.with-children > summary.tool-card-header::before {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    content: "▸";
    flex-shrink: 0;
    font-size: 10px;
    transition: transform 100ms ease;
  }

  .tool-card.with-children[open] > summary.tool-card-header::before {
    transform: rotate(90deg);
  }

  /* Nested children container — indented and bordered on the leading edge
     so the delegation boundary is visually obvious.

     Chromium's `<details>` does NOT apply a `display: none` UA rule to
     non-summary children when closed — it relies on shadow-DOM slotting,
     which our light-DOM-rendered children bypass. Explicitly hide them
     when the delegate is collapsed so the auto-collapse-after-done
     behavior is actually visible. */
  .tool-card.with-children > .tool-call-children {
    border-inline-start: 2px solid var(--color-border-2, var(--color-border-1));
    display: none;
    flex-direction: column;
    gap: var(--size-1);
    margin-inline-start: var(--size-3);
    padding: var(--size-1-5) 0 var(--size-1-5) var(--size-2);
  }
  .tool-card.with-children[open] > .tool-call-children {
    display: flex;
  }

  /* The output-drawer <details> inside a delegate card needs its own padding
     since `.tool-card.with-children` zeros the parent padding. Hide the
     drawer entirely when the delegate is collapsed (same shadow-DOM
     bypass workaround as the children container above). */
  .tool-card.with-children > .tool-card-details {
    display: none;
  }
  .tool-card.with-children[open] > .tool-card-details {
    display: block;
    padding: 0 var(--size-2-5) var(--size-1-5);
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

  /* ─── Shiki JSON highlighting ────────────────────────────────────────── */

  .tool-card-details :global(pre.shiki) {
    background: transparent !important;
    margin: 0;
  }

  .tool-card-details :global(pre.shiki code) {
    font-family: var(--font-family-mono, ui-monospace, monospace);
    font-size: var(--font-size-0, 11px);
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
