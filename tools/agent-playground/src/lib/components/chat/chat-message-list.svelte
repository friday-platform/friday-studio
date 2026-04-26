<script lang="ts">
  import { DropdownMenu, markdownToHTML } from "@atlas/ui";
  import { tick } from "svelte";
  import type { ChatMessage, ImageDisplay, ScheduleProposal, ToolCallDisplay } from "./types";
  import ScheduleProposalCard from "./schedule-proposal-card.svelte";
  import ToolCallCard from "./tool-call-card.svelte";
  import { isError, isInProgress, outputSummary } from "./tool-call-utils";

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
    /** Called when the user successfully connects a credential via an inline connect_service card. */
    onCredentialConnected?: (provider: string) => void;
    /**
     * When true, renders a placeholder assistant bubble with animated
     * dots at the bottom of the list — for the "submitted, no response
     * yet" window. Parent hides this as soon as the real assistant
     * message starts producing text or tool-call content.
     */
    thinking?: boolean;
  }

  const { messages, onScheduleAction, onCredentialConnected, thinking = false }: Props = $props();

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


</script>



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
                  <span class="group-icon" aria-hidden="true">
                    {#if anyRunning}
                      <span class="group-pulse"></span>
                    {:else if calls.some((c) => isError(c.state))}
                      <span class="group-error-mark">✗</span>
                    {:else}
                      <span class="group-success-mark">✓</span>
                    {/if}
                  </span>
                  <span class="tool-group-label">{toolGroupSummary(calls)}</span>
                  <span class="group-chevron" aria-hidden="true">
                    {#if isOpen}
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M4.22 6.22a.75.75 0 0 1 1.06 0L8 8.94l2.72-2.72a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.28a.75.75 0 0 1 0-1.06Z" clip-rule="evenodd"/></svg>
                    {:else}
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M6.22 4.22a.75.75 0 0 1 1.06 0l3.25 3.25a.75.75 0 0 1 0 1.06l-3.25 3.25a.75.75 0 0 1-1.06-1.06L8.94 8 6.22 5.28a.75.75 0 0 1 0-1.06Z" clip-rule="evenodd"/></svg>
                    {/if}
                  </span>
                </summary>
                <div class="tool-call-list">
                  {#each calls as call (call.toolCallId || call.toolName)}
                    <ToolCallCard {call} {onCredentialConnected} />
                  {/each}
                </div>
              </details>
            {:else}
              <div class="tool-call-list">
                {#each calls as call (call.toolCallId || call.toolName)}
                  <ToolCallCard {call} {onCredentialConnected} />
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

  /* ─── Tool-call list ───────────────────────────────────────────────── */

  .tool-call-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  /* Collapsible group wrapper (shown when a message has ≥ 3 tool calls). */
  .tool-call-group {
    background-color: var(--surface-dark);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    overflow: hidden;
  }

  .tool-call-group-summary {
    align-items: center;
    background-color: var(--surface);
    color: var(--text);
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

  .group-icon {
    display: inline-flex;
    flex-shrink: 0;
    inline-size: 14px;
    block-size: 14px;
    justify-content: center;
    align-items: center;
  }

  .group-pulse {
    animation: group-pulse 1.2s ease-in-out infinite;
    background-color: var(--blue-primary);
    border-radius: 50%;
    display: inline-block;
    inline-size: 8px;
    block-size: 8px;
  }

  @keyframes group-pulse {
    0%, 100% { opacity: 0.4; transform: scale(0.9); }
    50% { opacity: 1; transform: scale(1.1); }
  }

  .group-error-mark {
    color: var(--red-primary);
    font-size: 12px;
    font-weight: var(--font-weight-6);
  }

  .group-success-mark {
    color: var(--green-primary);
    font-size: 12px;
    font-weight: var(--font-weight-6);
  }

  .tool-group-label {
    color: var(--text-faded);
    flex: 1;
    font-family: var(--font-family-mono, ui-monospace, monospace);
    font-size: var(--font-size-1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .group-chevron {
    color: var(--text-faded);
    display: inline-flex;
    flex-shrink: 0;
    inline-size: 12px;
    block-size: 12px;
    transition: transform 150ms ease;
  }

  .tool-call-group[open] > .tool-call-group-summary .group-chevron {
    transform: rotate(90deg);
  }

  .tool-call-group[open] > .tool-call-list {
    border-block-start: 1px solid var(--color-border-1);
    padding: var(--size-1-5);
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
