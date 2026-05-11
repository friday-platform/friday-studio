<script lang="ts">
  import { DropdownMenu, markdownToHTMLSafe } from "@atlas/ui";
  import { tick } from "svelte";
  import type { ChatMessage } from "./types";
  import { getExportContext } from "./export-context";
  import ToolBurst from "./tool-burst.svelte";
  import ToolCallCard from "./tool-call-card.svelte";
  import { needsUserAction } from "./tool-call-utils";
  import ValidationPillRow from "./validation-pill-row.svelte";
  import type { ValidationAttemptDisplay } from "./validation-accumulator.ts";
  import UsageBadge from "./usage-badge.svelte";
  import { formatMessageTimestamp } from "@atlas/core/chat/export/render";

  // Per-message timestamp formatters. Default is HH:MM:SS in the user's
  // locale; the alt-pressed view swaps in full date + time so the
  // operator can confirm a turn happened on the day they think it did
  // without leaving the row.
  const TIME_FMT = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
  const DATETIME_FMT = new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
  function formatTimeShort(timestamp: number): string {
    return TIME_FMT.format(new Date(timestamp));
  }
  function formatDateTimeFull(timestamp: number): string {
    return DATETIME_FMT.format(new Date(timestamp));
  }

  /** Per-turn wall-clock duration in ms, or `null` when either
   *  endpoint is missing / malformed. */
  function turnDurationMs(msg: ChatMessage): number | null {
    const start = msg.metadata?.startTimestamp;
    const end = msg.metadata?.endTimestamp;
    if (!start || !end) return null;
    const a = Date.parse(start);
    const b = Date.parse(end);
    if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null;
    return b - a;
  }

  /** 950ms / 4.2s / 1m 12s — kept terse to fit alongside the time. */
  function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.floor((ms % 60_000) / 1000);
    return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  }

  // Global alt-key state. Held → time elements display the full
  // date + time format; released → back to compact HH:MM:SS. Single
  // listener pair on window keeps every message reactive to one
  // source. Hover tooltip (title="...") is also set so the same info
  // is reachable without a keyboard chord.
  let altPressed = $state(false);
  $effect(() => {
    function onDown(e: KeyboardEvent) {
      if (e.key === "Alt" && !altPressed) altPressed = true;
    }
    function onUp(e: KeyboardEvent) {
      if (e.key === "Alt" && altPressed) altPressed = false;
    }
    function onBlur() {
      altPressed = false;
    }
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
    };
  });

  // Pull every text segment out of a chat message for the "Copy
  // message" action. Tool-bursts contribute their visible reasoning
  // commentary (when present) — the raw tool I/O is debug detail and
  // would bloat a copy-paste; users grabbing the message want the
  // prose.
  function messageTextForCopy(msg: ChatMessage): string {
    const parts: string[] = [];
    for (const segment of msg.segments) {
      if (segment.type === "text" && segment.content.length > 0) {
        parts.push(segment.content);
      } else if (segment.type === "tool-burst" && segment.reasoning) {
        parts.push(segment.reasoning);
      }
    }
    return parts.join("\n\n");
  }

  async function copyMessageText(msg: ChatMessage): Promise<void> {
    const text = messageTextForCopy(msg);
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Permission denied or insecure context — silent failure is
      // fine; the menu closing is feedback enough.
    }
  }

  interface Props {
    messages: ChatMessage[];
    /** Called when the user successfully connects a credential via an inline connect_service card. */
    onCredentialConnected?: (provider: string) => void;
    /**
     * When true, renders a placeholder assistant bubble with animated
     * dots at the bottom of the list — for the "submitted, no response
     * yet" window. Parent hides this as soon as the real assistant
     * message starts producing text or tool-call content.
     */
    thinking?: boolean;
    /**
     * Validation lifecycle attempts grouped by sessionId, then by FSM
     * actionId. The chat surfaces one `<ValidationPillRow>` per attempt
     * after the tool calls of the assistant message that owns the
     * session. Empty / undefined → no pills render.
     */
    validationAttemptsBySession?: Map<string, Map<string, ValidationAttemptDisplay[]>>;
  }

  const {
    messages,
    onCredentialConnected,
    thinking = false,
    validationAttemptsBySession,
  }: Props = $props();

  /**
   * Flatten the per-action attempts map for a single session into a
   * stable render order: sort actions by first-seen attempt index
   * (tracked implicitly by Map insertion order from the accumulator),
   * then attempts within an action ascending by `attempt`. The
   * accumulator already sorts attempts within an action.
   */
  function pillsForSession(
    sessionId: string | undefined,
  ): Array<{ actionId: string; attempt: ValidationAttemptDisplay }> {
    if (!sessionId || !validationAttemptsBySession) return [];
    const byAction = validationAttemptsBySession.get(sessionId);
    if (!byAction) return [];
    const flat: Array<{ actionId: string; attempt: ValidationAttemptDisplay }> = [];
    for (const [actionId, attempts] of byAction) {
      for (const attempt of attempts) {
        flat.push({ actionId, attempt });
      }
    }
    return flat;
  }

  /**
   * Detect whether any pill in this message reached terminal failure.
   * Triggers an additional system-level error chunk matching the
   * existing job-failure UI pattern (Resolved Decision §7).
   */
  function hasTerminalFail(
    pills: ReturnType<typeof pillsForSession>,
  ): boolean {
    return pills.some(
      (p) => p.attempt.status === "failed" && p.attempt.terminal === true,
    );
  }

  let containerEl: HTMLDivElement | undefined = $state();

  // Auto-scroll to bottom as new messages or tool updates arrive. We watch
  // both the length of the outer list and the total tool-call count so mid-
  // stream tool activity (no new messages, just updated tool cards on the
  // in-flight assistant message) still triggers scroll.
  const totalToolCallCount = $derived(
    messages.reduce(
      (sum, m) =>
        sum +
        m.segments.reduce(
          (s, seg) => s + (seg.type === "tool-burst" ? seg.calls.length : 0),
          0,
        ),
      0,
    ),
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

  const BRAILLE_FRAMES = ["⠀", "⠁", "⠉", "⠙", "⠚", "⠛", "⠟", "⠿", "⠟", "⠛", "⠚", "⠙", "⠉", "⠁"];
  let brailleFrame = $state(0);

  $effect(() => {
    if (!thinking) {
      brailleFrame = 0;
      return;
    }
    const id = setInterval(() => {
      brailleFrame = (brailleFrame + 1) % BRAILLE_FRAMES.length;
    }, 100);
    return () => clearInterval(id);
  });

  /**
   * Suppresses the markdown copy-button injection (which depends on JS)
   * when the list renders inside an export. The markdown content still
   * renders; only the per-block copy affordance is skipped.
   */
  const isExport = getExportContext() !== undefined;

  /**
   * Svelte action: inject a "Copy" button on every <pre> and <table> inside
   * a `.markdown-body` container. Runs after initial render and re-scans
   * when the DOM subtree changes (streaming content). No-ops in export
   * mode so the static HTML is button-free.
   */
  function copyButtons(node: HTMLElement) {
    if (isExport) return;
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
    <div
      class="message"
      class:user={message.role === "user"}
      class:assistant={message.role === "assistant"}
      class:system={message.role === "system"}
    >
        {#if message.role === "system"}
          {@const text = message.segments
            .filter((s): s is { type: "text"; content: string } => s.type === "text")
            .map((s) => s.content)
            .join("")}
          {#if text}
            <div class="message-content system-content">{text}</div>
          {/if}
        {:else}
          <span class="role-badge">{message.role === "user" ? "You" : "Friday"}</span>

          {#each message.segments as segment}
            {#if segment.type === "text" && segment.content.length > 0}
              {#if message.role === "assistant"}
                <div class="message-content markdown-body" use:copyButtons>{@html markdownToHTMLSafe(segment.content)}</div>
              {:else}
                <div class="message-content">{segment.content}</div>
              {/if}
            {:else if segment.type === "tool-burst"}
              {@const regularCalls = segment.calls.filter((c) => !needsUserAction(c))}
              {@const actionCalls = segment.calls.filter((c) => needsUserAction(c))}
              {#if regularCalls.length > 0}
                <ToolBurst
                  calls={regularCalls}
                  reasoning={segment.reasoning}
                  {onCredentialConnected}
                />
              {/if}
              {#if actionCalls.length > 0}
                <div class="tool-call-list">
                  {#each actionCalls as call (call.toolCallId || call.toolName)}
                    <ToolCallCard {call} {onCredentialConnected} />
                  {/each}
                </div>
              {/if}
            {/if}
          {/each}

          {@const sessionPills = message.role === "assistant"
            ? pillsForSession(message.metadata?.sessionId)
            : []}
          {#if sessionPills.length > 0}
            <!-- Validation pills sit after all segments — the validator runs
                 after the LLM returns, so chronological order matches what
                 actually happened. -->
            <div class="validation-pill-list">
              {#each sessionPills as { actionId, attempt } (`${actionId}-${attempt.attempt}`)}
                <ValidationPillRow
                  attempt={attempt.attempt}
                  status={attempt.status}
                  terminal={attempt.terminal}
                  verdict={attempt.verdict}
                />
              {/each}
            </div>
          {/if}

          {#if hasTerminalFail(sessionPills)}
            <!-- Terminal-fail second surface (Resolved Decision §7): a
                 system-level error chunk matching the existing
                 job-failure pattern, alongside the failed-terminal pill
                 above. Two layers of state, two surfaces — the user does
                 not have to learn a new "this job is dead" affordance. -->
            <div class="message-error" role="alert" aria-live="assertive">
              <span class="message-error-icon" aria-hidden="true">⚠</span>
              <div class="message-error-body">
                <div class="message-error-title">Job stopped: validation failed</div>
                <div class="message-error-detail">
                  Output validation failed after retry. See the validation pill above for details.
                </div>
              </div>
            </div>
          {/if}

          {#if message.images && message.images.length > 0}
            <div class="message-images">
              {#each message.images as img}
                <img src={img.url} alt={img.filename ?? "attached image"} class="chat-image" />
              {/each}
            </div>
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

          {#if message.disconnectedIntegrations && message.disconnectedIntegrations.length > 0}
            <!-- Non-fatal info chip: an MCP integration's credential is dead so
                 its tools were skipped this session. The session still ran;
                 the user just needs to reconnect the integration to use those
                 tools again. -->
            <div class="message-notice" role="status">
              <span class="message-notice-icon" aria-hidden="true">⚠</span>
              <div class="message-notice-body">
                {#each message.disconnectedIntegrations as integration (integration.serverId)}
                  <div class="message-notice-row">
                    <strong>{integration.provider ?? integration.serverId}</strong>
                    is disconnected — reconnect in Settings → Connections to use those tools.
                  </div>
                {/each}
              </div>
            </div>
          {/if}

          <!-- Per-message actions row. Two shapes:
                 • Live UI — compact (alt→full) timestamp + optional turn
                   duration + UsageBadge + ellipsis menu. Layout flips by
                   role: assistant left-aligned, user right-aligned.
                 • Export mode — JS-driven affordances (dropdown, alt-key
                   toggle, badges) are dead in static HTML, so we render
                   just the message timestamp in main's full-date style,
                   no cache/token info. The raw timestamp also lives in
                   chat.json for anyone who wants it.
               System messages stay quiet (no menu, no time). -->
          {@const fullTime = formatDateTimeFull(message.timestamp)}
          {@const compactTime = formatTimeShort(message.timestamp)}
          {@const duration = message.role === "assistant" ? turnDurationMs(message) : null}
          <div class="message-actions" class:assistant={message.role === "assistant"} class:user={message.role === "user"}>
            {#if isExport}
              <span class="message-time">{formatMessageTimestamp(message.metadata)}</span>
            {:else}
              <span class="message-time" title={fullTime}>
                {altPressed ? fullTime : compactTime}
              </span>
              {#if duration !== null}
                <span class="turn-duration" title="turn duration">{formatDuration(duration)}</span>
              {/if}
              {#if message.role === "assistant" && message.metadata?.usage}
                <UsageBadge
                  usage={message.metadata.usage}
                  provider={message.metadata.provider}
                  startTimestamp={message.metadata.startTimestamp}
                  endTimestamp={message.metadata.endTimestamp}
                />
              {/if}
              <DropdownMenu.Root positioning={{ placement: message.role === "user" ? "bottom-end" : "bottom-start" }}>
                {#snippet children()}
                  <DropdownMenu.Trigger class="message-menu-trigger" aria-label="Message options">
                    <!-- Dots shifted toward the bottom of the viewBox so
                         the ellipsis aligns with the bottom of the
                         neighboring text rather than centering on its
                         own taller bounding box. -->
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 16 16"
                      fill="none"
                      aria-hidden="true"
                    >
                      <circle cx="4" cy="13" r="1.25" fill="currentColor" />
                      <circle cx="8" cy="13" r="1.25" fill="currentColor" />
                      <circle cx="12" cy="13" r="1.25" fill="currentColor" />
                    </svg>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Content>
                    <!-- Convention: every dropdown item ships an icon
                         via the `prepend` snippet. Keeps the column of
                         items aligned to a consistent glyph rail. New
                         items follow this shape:
                           <DropdownMenu.Item onclick={...}>
                             {#snippet prepend()}
                               <svg class="menu-icon" .../>
                             {/snippet}
                             Label
                           </DropdownMenu.Item>
                         — see `Copy message` below. -->
                    <DropdownMenu.Item onclick={() => void copyMessageText(message)}>
                      {#snippet prepend()}
                        <svg
                          class="menu-icon"
                          width="14"
                          height="14"
                          viewBox="0 0 16 16"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="1.4"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          aria-hidden="true"
                        >
                          <rect x="5" y="5" width="9" height="9" rx="1.5" />
                          <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" />
                        </svg>
                      {/snippet}
                      Copy message
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                {/snippet}
              </DropdownMenu.Root>
            {/if}
          </div>
      {/if}
    </div>
  {/each}

  {#if thinking}
    <!-- Placeholder assistant bubble shown between send and first-token.
         Replaced in-place by the real assistant message as soon as text
         or a tool-call arrives. Same layout as .message.assistant so
         there's no visual jump when the swap happens. -->
    <div class="message assistant thinking-bubble" role="status" aria-live="polite">
      <span class="role-badge">Friday</span>
      <div class="message-content thinking-content">
        <span class="braille-spinner" aria-hidden="true">{BRAILLE_FRAMES[brailleFrame]}</span>
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
    max-inline-size: 95%;
  }

  .message.user {
    align-self: flex-end;
  }

  .message.assistant {
    margin-inline-end: auto;
    width: 100%;
  }

  /* Compact actions row — ellipsis menu, time, optional usage badge.
     Sits just below the bubble. Whole row dims until hovered so it
     stays out of the way of message reading. `align-items: flex-end`
     anchors every child to the row's bottom edge so the ellipsis
     sits flush with the bottom of the text rather than floating
     above it. */
  .message-actions {
    align-items: flex-end;
    /* More breathing room between items so glyphs don't crowd each
       other. Hidden items (like cache %) live at the trailing edge of
       the row; this gap also keeps them from sticking to their
       neighbor when they fade in. */
    column-gap: 1rem;
    display: flex;
    flex-wrap: wrap;
    font-size: 0.7rem;
    line-height: 1;
    opacity: 0.6;
    padding-block-start: 2px;
    row-gap: 0;
    transition: opacity 120ms ease;
  }
  .message:hover .message-actions,
  .message-actions:focus-within {
    opacity: 1;
  }
  /* DOM order is `[time, duration?, usage?, trigger]` for both
     roles, so the ellipsis is always last. Both roles start-align
     the row content so the time-glyph aligns with the first letter
     of the message body — for assistant that's the left of the
     bubble text, for user that's the left of the (right-anchored)
     bubble text. The ellipsis docks at the trailing edge in either
     case via `margin-inline-start: auto` on the trigger.
     Inline padding on both sides matches the chat bubble's own
     inline padding (`var(--size-3)` on `.message-content`) so the
     row's content edges sit flush with the bubble's text edges. */
  .message-actions.assistant,
  .message-actions.user {
    justify-content: flex-start;
    padding-inline-end: var(--size-3);
    padding-inline-start: var(--size-3);
  }

  .message-time {
    color: var(--text-faded);
    cursor: default;
    font-variant-numeric: tabular-nums;
    user-select: none;
  }

  .turn-duration {
    color: var(--text-faded);
    cursor: default;
    font-variant-numeric: tabular-nums;
    user-select: none;
  }

  /* Cache hit ratio collapses to zero width by default and slides
     in (max-inline-size + opacity) when the row is hovered. Without
     animating the width too, the cache element kept reserving its
     `column-gap` space even when invisible — the ellipsis ended up
     two gaps beyond the last visible stat and read as marooned.
     Negative margin-inline cancels both surrounding column-gaps in
     the collapsed state so the row tightens up; the negatives
     return to `0` on hover and the gaps re-establish naturally. */
  .message-actions :global(.cache-text) {
    margin-inline: calc(-1 * 1rem);
    max-inline-size: 0;
    opacity: 0;
    overflow: hidden;
    transition:
      max-inline-size 200ms ease,
      margin-inline 200ms ease,
      opacity 160ms ease 40ms;
    white-space: nowrap;
  }
  .message:hover .message-actions :global(.cache-text),
  .message-actions:focus-within :global(.cache-text) {
    margin-inline: 0;
    max-inline-size: 5rem;
    opacity: 1;
  }

  .message-actions :global(.message-menu-trigger) {
    /* Sized to match the row's text height so the dots line up with
       the bottom of the time / usage labels instead of floating above
       them. The SVG fills the trigger; the dots sit at viewBox center,
       which now overlaps the text's mid-band rather than the row's
       own taller bounding box.
       `margin-inline-start: auto` parks the trigger at the trailing
       edge of the row regardless of role — when the row has spare
       horizontal space (assistant rows fill the full column width),
       the auto-margin consumes it and pushes the trigger right; when
       the row is content-width (user rows), the auto-margin
       collapses to zero and the trigger sits adjacent to its
       neighbor. Either way, ellipsis docks right. */
    align-items: center;
    background: transparent;
    block-size: 12px;
    border: none;
    border-radius: var(--radius-1);
    color: var(--text-faded);
    cursor: pointer;
    display: inline-flex;
    inline-size: 16px;
    justify-content: center;
    margin-inline-start: auto;
    padding: 0;
    transition: background-color 120ms ease, color 120ms ease;
  }
  .message-actions :global(.message-menu-trigger svg) {
    block-size: 12px;
    inline-size: 12px;
  }
  .message-actions :global(.message-menu-trigger:hover),
  .message-actions :global(.message-menu-trigger[data-state="open"]) {
    background: var(--highlight);
    color: var(--text);
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
  .braille-spinner {
    display: inline-block;
    font-family: var(--font-family-mono, ui-monospace, monospace);
    font-size: 1.15em;
    inline-size: 1.2em;
    text-align: center;
  }

  @media (prefers-reduced-motion: reduce) {
    .braille-spinner { animation: none; }
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

  .message-notice {
    align-items: flex-start;
    background-color: light-dark(#fffbeb, color-mix(in srgb, #d97706, black 70%));
    border: 1px solid light-dark(#fde68a, color-mix(in srgb, #d97706, black 40%));
    border-radius: var(--radius-3);
    color: light-dark(#92400e, #fde68a);
    display: flex;
    font-size: var(--font-size-2);
    gap: var(--size-2);
    line-height: 1.5;
    padding: var(--size-2-5) var(--size-3);
  }
  .message-notice-icon {
    flex-shrink: 0;
    font-size: 1.1em;
  }
  .message-notice-body {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-inline-size: 0;
  }
  .message-notice-row {
    overflow-wrap: anywhere;
  }

  .message-content {
    background-color: var(--color-surface-3);
    border-radius: var(--radius-3);
    font-size: var(--font-size-3);
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

  .message-content.markdown-body :global(ul) {
    list-style-type: disc;
    margin-block: 0.4em;
    padding-inline-start: 1.4em;
  }

  .message-content.markdown-body :global(ol) {
    list-style-type: decimal;
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
    /* Horizontal overflow lives on the .copyable-wrapper below.
       `overflow-x` on a <table> itself is a no-op — tables size to
       content and aren't scroll containers. */
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
    /* Wrap-rather-than-overflow is what gives `<table>` a horizontal
       scrollbar when its content is wider than the chat bubble. The
       wrapper is the scroll container; the table itself stays
       naturally sized. `<pre>` blocks have their own
       `overflow-x: auto` further up, so their wrapper just sits
       transparently around them without producing a second scrollbar. */
    max-inline-size: 100%;
    overflow-x: auto;
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
    gap: var(--size-1-5);
  }

  /* Validation pills sit alongside (and after) tool-call cards — same
     indent and gap so the visual hierarchy stays consistent. */
  .validation-pill-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
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
    font-size: var(--font-size-4);
  }

  .empty-state .hint {
    font-size: var(--font-size-3);
    max-inline-size: 400px;
  }
</style>
