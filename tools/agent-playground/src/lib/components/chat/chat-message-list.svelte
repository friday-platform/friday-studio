<script lang="ts">
  import { DropdownMenu } from "@atlas/ui";
  import MarkdownBody from "./markdown-body.svelte";
  import { createVirtualizer } from "@tanstack/svelte-virtual";
  import { tick, untrack } from "svelte";
  import type { ChatMessage } from "./types";
  import { getExportContext } from "./export-context";
  import ToolBurst from "./tool-burst.svelte";
  import ToolCallCard from "./tool-call-card.svelte";
  import { needsUserAction } from "./tool-call-utils";
  import ValidationPillRow from "./validation-pill-row.svelte";
  import type { ValidationAttemptDisplay } from "./validation-accumulator.ts";
  import UsageBadge from "./usage-badge.svelte";
  import { formatMessageTimestamp } from "@atlas/core/chat/export/render";
  import { tableToMarkdown } from "./table-to-markdown";
  import { tableToCSV } from "./table-to-csv";
  import { tableToSafeHTML } from "./table-to-html";
  import { snapshotTableToArtifact } from "./snapshot-table";

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
    /**
     * Workspace + chat ids for the inline-table Actions menu's "Open in
     * dedicated view" path. The handler auto-snapshots the rendered
     * <table> to a markdown artifact tagged with these ids, then
     * opens `/artifacts/<id>/table` in a new tab. Both are optional —
     * when missing the menu omits the Open option but Copy / Download
     * CSV / Download MD still work without round-tripping.
     */
    workspaceId?: string;
    chatId?: string;
  }

  const {
    messages,
    onCredentialConnected,
    thinking = false,
    validationAttemptsBySession,
    workspaceId,
    chatId,
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

  // Virtualizer tunables. `estimateSize` matches a typical assistant
  // bubble with one short paragraph — the wrong-by-2x case is bounded
  // by `overscan` so the user never sees a blank gap. `overscan` is
  // measured in items above/below the viewport; 5 covers a screen of
  // fast scrolling without rendering the entire history off-screen.
  const VIRTUAL_ESTIMATE_SIZE_PX = 200;
  const VIRTUAL_OVERSCAN_ITEMS = 5;

  // Virtualizer for the message list. svelte-virtual v3.x is store-
  // backed (Svelte 4 contract), so consumers read `$virtualizer.*` in
  // template. `count` is set initially to the messages array length
  // and pushed reactively via `setOptions` below. `getScrollElement`
  // is a closure on the reactive `containerEl` — null at first render
  // (the `bind:this` hasn't fired yet), non-null on subsequent renders;
  // the template gates `$virtualizer` access behind `{#if containerEl}`
  // so the virtualizer's `_didMount` only runs once the scroll element
  // exists.
  // Virtualize only the messages array — thinking bubble stays as a
  // natural sibling outside the virtualizer (its content animates on a
  // timer, which would otherwise re-trigger measureElement; and the
  // count flicker when thinking flips false right as a new message
  // arrives would cause a one-frame layout shift).
  const virtualCount = $derived(messages.length);
  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: virtualCount,
    getScrollElement: () => containerEl ?? null,
    estimateSize: () => VIRTUAL_ESTIMATE_SIZE_PX,
    overscan: VIRTUAL_OVERSCAN_ITEMS,
  });

  // Push count updates to the virtualizer. `untrack` keeps this effect
  // from subscribing to the store value when calling `setOptions` —
  // otherwise the store's internal `writable.set(virtualizer)` (which
  // fires on every `setOptions`) would re-trigger this effect, looping.
  $effect(() => {
    const count = virtualCount;
    untrack(() => {
      $virtualizer.setOptions({
        count,
        getScrollElement: () => containerEl ?? null,
        estimateSize: () => VIRTUAL_ESTIMATE_SIZE_PX,
        overscan: VIRTUAL_OVERSCAN_ITEMS,
      });
    });
  });

  // Auto-scroll-to-bottom trigger. Only the in-flight (last) message
  // changes during streaming — earlier messages are immutable from the
  // moment they're appended — so a tail-only count tracks "mid-stream
  // tool activity" without re-walking every message × every segment on
  // every reactive tick. Heavy delegation (30+ tool calls per turn,
  // 50+ messages of history) used to compound this into a hot reduce
  // that fired the scroll effect on every token.
  const tailToolCallCount = $derived.by(() => {
    const last = messages[messages.length - 1];
    if (!last) return 0;
    let sum = 0;
    for (const seg of last.segments) {
      if (seg.type === "tool-burst") sum += seg.calls.length;
    }
    return sum;
  });

  // Dedupe disconnect chips across messages: once a (serverId, kind) pair
  // has shown up in an earlier message, the same pair on a later message
  // does NOT re-render its banner. In practice two agents in one turn
  // (workspace-chat top-level + a delegated sub-agent) both run
  // `createMCPTools` against the same dead MCP and each emit a
  // disconnect entry. Without this dedup the user sees the same chip
  // twice — confirmed via Chrome QA.
  const disconnectIntegrationsByMessageId = $derived.by(() => {
    const map = new Map<string, ChatMessage["disconnectedIntegrations"]>();
    const seen = new Set<string>();
    for (const m of messages) {
      const raw = m.disconnectedIntegrations;
      if (!raw || raw.length === 0) continue;
      const kept = raw.filter((i) => {
        const key = `${i.serverId}::${i.kind}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (kept.length > 0) map.set(m.id, kept);
    }
    return map;
  });

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
    if (!containerEl) return;
    // Two complications drive the multi-pass:
    //  1. The virtualizer reports `getTotalSize()` from a mix of
    //     measured + estimated item heights. On first paint after a
    //     rehydration, most items are still at `estimateSize` and the
    //     reported total is far smaller than reality.
    //  2. `measureElement` reads `offsetHeight` inside a ResizeObserver
    //     callback, which is async to the render pass. Between
    //     "messages are in the DOM" and "the virtualizer knows their
    //     real sizes" there's at least one animation frame.
    // The scroll passes below catch each settling step. Plain
    // `scrollTop = scrollHeight` works once the virtualizer's total
    // size is accurate; until then we use `scrollToIndex` which
    // self-corrects to the last item as measurements arrive.
    if (virtualCount > 0) {
      $virtualizer.scrollToIndex(virtualCount - 1, { align: "end" });
    }
    containerEl.scrollTop = containerEl.scrollHeight;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    if (!containerEl) return;
    if (virtualCount > 0) {
      $virtualizer.scrollToIndex(virtualCount - 1, { align: "end" });
    }
    containerEl.scrollTop = containerEl.scrollHeight;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    if (!containerEl) return;
    containerEl.scrollTop = containerEl.scrollHeight;
  }

  $effect(() => {
    // deps: messages.length, tailToolCallCount
    const _len = messages.length;
    const _calls = tailToolCallCount;
    // Only scroll if the user is still anchored at the bottom. If they
    // scrolled up to read history, honor that — otherwise we'd hijack
    // their position every token and the chat would be unreadable during
    // generation. Re-enabling follow is implicit: when they scroll back
    // to the bottom, `handleScroll` flips `followBottom` to true.
    if (followBottom) {
      void scrollToBottom();
    }
  });

  // Re-anchor to bottom whenever the virtualizer's inner spacer grows.
  // `measureElement` is ResizeObserver-backed and async, so the total
  // size after a rehydration or a streaming delta keeps growing for a
  // few frames after the each-loop renders. Without this, the initial
  // `scrollToBottom` calls land mid-scroll because they fire before
  // the final measurements arrive. Tied to `followBottom` so we don't
  // hijack a user who has scrolled up.
  //
  // During streaming the inner spacer resizes on every measured-row
  // change, which means a naive ResizeObserver callback fires N times
  // per chunk and each fire reads `scrollHeight` synchronously —
  // forcing layout flush right after the virtualizer just dirtied
  // layout. Coalesce to one anchor per frame so streaming pays for at
  // most one forced reflow per paint, not N.
  $effect(() => {
    if (!containerEl) return;
    const inner = containerEl.querySelector(".virtual-inner");
    if (!inner) return;
    let anchorScheduled = false;
    const observer = new ResizeObserver(() => {
      if (!followBottom || !containerEl) return;
      if (anchorScheduled) return;
      anchorScheduled = true;
      requestAnimationFrame(() => {
        anchorScheduled = false;
        if (followBottom && containerEl) {
          containerEl.scrollTop = containerEl.scrollHeight;
        }
      });
    });
    observer.observe(inner);
    return () => observer.disconnect();
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
        // Skip if already wrapped (closest handles either flat <pre>
        // wrapping or the nested <table> wrapping introduced below).
        if (el.closest(".copyable-wrapper")) continue;

        // Outer wrapper is the positioning context for the copy
        // button. For tables, we add an inner `.copyable-scroll` div
        // that owns the horizontal-overflow so wide tables scroll
        // without dragging the absolutely-positioned button along
        // with the content. `<pre>` handles its own internal scroll
        // (see the markdown-body :global(pre) rule below) so it sits
        // directly inside the wrapper.
        const wrapper = document.createElement("div");
        wrapper.className = "copyable-wrapper";
        el.parentNode?.insertBefore(wrapper, el);
        if (el.tagName === "TABLE") {
          const scroller = document.createElement("div");
          scroller.className = "copyable-scroll";
          wrapper.appendChild(scroller);
          scroller.appendChild(el);
        } else {
          wrapper.appendChild(el);
        }

        if (el.tagName === "TABLE") {
          wrapper.appendChild(buildTableActionsMenu(el as HTMLTableElement));
        } else {
          wrapper.appendChild(buildPreCopyButton(el as HTMLElement));
        }
      }
    }

    injectButtons();

    // Streaming markdown re-renders `{@html ...}` on every token, which
    // fires this observer per delta. The naive callback would re-scan
    // the whole subtree (`querySelectorAll('pre, table')`) for each
    // mutation record — quadratic on long answers and the actual
    // main-thread cost behind the heavy-delegation lockup. Coalesce
    // pending scans to one per animation frame; the result is the same
    // (every block eventually gets a button) at O(rendered-blocks/frame).
    let scanScheduled = false;
    const observer = new MutationObserver(() => {
      if (scanScheduled) return;
      scanScheduled = true;
      requestAnimationFrame(() => {
        scanScheduled = false;
        injectButtons();
      });
    });
    observer.observe(node, { childList: true, subtree: true });

    return {
      destroy() {
        observer.disconnect();
        // Tear down any Actions menu that was open when the list
        // unmounts (navigate to another chat, close the inspector,
        // HMR refresh). Without this, the document-level pointerdown
        // and keydown listeners that `openMenu` attached stay alive
        // pointing at GC-collectible nodes — small leak per open menu
        // and a confusing dev-tools state after a few HMR cycles.
        currentOpenClose?.();
      },
    };
  }

  /**
   * Simple Copy button for `<pre>` blocks — no MD / CSV / Open
   * affordances apply, so we keep the pre-existing single-button
   * UX rather than wrapping a one-item dropdown.
   */
  function buildPreCopyButton(el: HTMLElement): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.className = "copy-btn";
    btn.setAttribute("aria-label", "Copy to clipboard");
    btn.textContent = "Copy";
    btn.addEventListener("click", () => {
      const flash = (label: string): void => {
        btn.textContent = label;
        setTimeout(() => {
          btn.textContent = "Copy";
        }, 1500);
      };
      const text = el.textContent ?? "";
      void navigator.clipboard.writeText(text).then(
        () => flash("Copied!"),
        () => flash("Copy failed"),
      );
    });
    return btn;
  }

  /**
   * Actions dropdown for `<table>` blocks. Four items:
   *
   *   Copy                  — multi-format clipboard write (markdown
   *                           text/plain + sanitized text/html — see
   *                           table-to-html.ts for why we don't
   *                           round-trip outerHTML)
   *                           so Sheets/Excel pasting works alongside
   *                           code-editor / Slack / GitHub paste.
   *   Open in dedicated view — auto-snapshots the table to a markdown
   *                            artifact, then opens
   *                            /artifacts/<id>/table in a new tab.
   *                            Hidden when workspaceId is unknown
   *                            (component used outside a workspace
   *                            context, e.g. ephemeral preview).
   *   Download CSV           — RFC-4180 file download.
   *   Download MD            — GitHub-flavored markdown download.
   *
   * Implemented as a vanilla-DOM popover rather than the Svelte
   * DropdownMenu because the chat body is `{@html ...}` (no Svelte
   * children inside the rendered markdown). Click-outside + ESC
   * close. Only one menu open at a time across the page — clicking
   * another Actions button closes any existing one first.
   */
  function buildTableActionsMenu(table: HTMLTableElement): HTMLDivElement {
    const container = document.createElement("div");
    container.className = "table-actions";

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "copy-btn";
    trigger.setAttribute("aria-haspopup", "true");
    trigger.setAttribute("aria-expanded", "false");
    trigger.setAttribute("aria-label", "Table actions");
    trigger.textContent = "Actions ▾";
    container.appendChild(trigger);

    const menu = document.createElement("div");
    menu.className = "table-actions-menu";
    menu.setAttribute("role", "menu");
    menu.hidden = true;
    container.appendChild(menu);

    // -- Item construction -----------------------------------------

    const flash = (label: string): void => {
      const previous = trigger.textContent;
      trigger.textContent = label;
      setTimeout(() => {
        trigger.textContent = previous ?? "Actions ▾";
      }, 1500);
    };

    const addItem = (label: string, onSelect: () => void): HTMLButtonElement => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "table-actions-item";
      item.setAttribute("role", "menuitem");
      item.textContent = label;
      item.addEventListener("click", () => {
        closeMenu();
        onSelect();
      });
      menu.appendChild(item);
      return item;
    };

    addItem("Copy", () => {
      const md = tableToMarkdown(table);
      // Rebuild HTML from a sanitizing serializer rather than
      // round-tripping `table.outerHTML` — agent-rendered chat tables
      // can carry attributes / nested formatting we don't want
      // landing in someone's downstream rich-text paste. See
      // `table-to-html.ts` for the threat model.
      const html = tableToSafeHTML(table);
      const writeMulti =
        typeof ClipboardItem !== "undefined" && navigator.clipboard.write
          ? navigator.clipboard.write([
              new ClipboardItem({
                "text/plain": new Blob([md], { type: "text/plain" }),
                "text/html": new Blob([html], { type: "text/html" }),
              }),
            ])
          : navigator.clipboard.writeText(md);
      void writeMulti.then(
        () => flash("Copied!"),
        () => flash("Copy failed"),
      );
    });

    // Open is omitted when we don't have a workspace to tag the
    // snapshot artifact with (chat-replay tool, exported HTML, unit
    // tests). The dedicated table view URL itself is workspace-
    // agnostic, but the snapshot needs an owning workspace to be
    // stored under.
    if (workspaceId) {
      addItem("Open in dedicated view", () => {
        flash("Opening…");
        void snapshotTableToArtifact(table, { workspaceId, chatId }).then(
          (artifactId) => {
            // New tab + no app chrome — the destination is its own
            // standalone surface. See `isChromeless` in the root
            // layout for the chrome opt-out. Linking directly to
            // the explicit table renderer skips the dispatcher
            // redirect.
            window.open(
              `/artifacts/${encodeURIComponent(artifactId)}/table`,
              "_blank",
              "noopener",
            );
          },
          (err) => {
            console.error("Failed to snapshot table:", err);
            flash("Open failed");
          },
        );
      });
    }

    addItem("Download CSV", () => {
      downloadTable(table, tableToCSV(table), "text/csv", "csv");
    });

    addItem("Download Markdown", () => {
      downloadTable(table, tableToMarkdown(table), "text/markdown", "md");
    });

    // -- Open/close state machine ----------------------------------
    //
    // `menu.hidden` is the source of truth — no shadow state. The
    // outside-detection runs on capture-phase `pointerdown` (fires
    // before `click`, in the capture pass so descendants can't stop
    // it) which closes the menu the instant the user presses
    // somewhere else on the page. The trigger's own click handler
    // toggles after, and an interior click (e.g. the trigger itself
    // to close) is recognized via `container.contains(e.target)`.

    const onPointerDown = (e: PointerEvent): void => {
      if (!container.contains(e.target as Node)) closeMenu();
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        closeMenu();
        trigger.focus();
      }
    };
    const openMenu = (): void => {
      if (!menu.hidden) return;
      closeAnyOpenActionsMenu();
      menu.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      currentOpenClose = closeMenu;
      document.addEventListener("pointerdown", onPointerDown, true);
      document.addEventListener("keydown", onKeyDown);
    };
    const closeMenu = (): void => {
      if (menu.hidden) return;
      menu.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
      if (currentOpenClose === closeMenu) currentOpenClose = null;
    };

    trigger.addEventListener("click", () => {
      if (menu.hidden) openMenu();
      else closeMenu();
    });

    return container;
  }

  /** Coordinates "only one Actions menu open at a time across the
   *  whole list" — opening a new menu calls back into the previous
   *  one's close(). Reset to null whenever a menu closes. */
  let currentOpenClose: (() => void) | null = null;
  function closeAnyOpenActionsMenu(): void {
    currentOpenClose?.();
  }

  function downloadTable(
    table: HTMLTableElement,
    text: string,
    mime: string,
    ext: string,
  ): void {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    // Derive a filename from the first header cell (or fall back).
    const firstHeader = table.querySelector("th, td")?.textContent?.trim() ?? "table";
    const slug =
      firstHeader
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "table";
    a.download = `${slug}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }


</script>



{#snippet messageBody(message: ChatMessage)}
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

          {@const dedupedDisconnects = disconnectIntegrationsByMessageId.get(message.id)}
          {#if dedupedDisconnects && dedupedDisconnects.length > 0}
            <!-- Non-fatal info chip: an MCP integration's credential is dead
                 (or temporarily unavailable) so its tools were skipped this
                 session. The session still ran; the user just needs to
                 reconnect the integration — or, for transient failures,
                 try again in a moment. Rendered ABOVE segments so the user
                 sees the "this integration is unavailable" context before
                 the answer text and tool cards, not as a trailing footer. -->
            <div
              class="message-notice"
              role="status"
              data-integration-disconnected="true"
            >
              <span class="message-notice-icon" aria-hidden="true">⚠</span>
              <div class="message-notice-body">
                {#each dedupedDisconnects as integration (integration.serverId)}
                  <div
                    class="message-notice-row"
                    data-testid={`integration-chip-${integration.kind}`}
                  >
                    {#if integration.kind === "credential_temporarily_unavailable"}
                      Friday couldn't reach
                      <strong>{integration.provider ?? integration.serverId}</strong>
                      this turn — try again in a moment.
                    {:else}
                      <strong>{integration.provider ?? integration.serverId}</strong>
                      is disconnected — reconnect in Settings → Connections to use those tools.
                    {/if}
                  </div>
                {/each}
              </div>
            </div>
          {/if}

          {#each message.segments as segment}
            {#if segment.type === "text" && segment.content.length > 0}
              {#if message.role === "assistant"}
                <div class="message-content markdown-body" use:copyButtons>
                  <MarkdownBody content={segment.content} />
                </div>
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
{/snippet}

<div class="message-list" bind:this={containerEl} onscroll={handleScroll}>
  {#if isExport}
    <!-- Export mode (static HTML or SSR — `bind:this` never fires, no
         scrolling): render every message eagerly. The virtualizer is a
         live-UI affordance; an exported file is read top-to-bottom. -->
    {#each messages as message (message.id)}
      {@render messageBody(message)}
    {/each}
  {:else if containerEl}
  <div class="virtual-inner" style:block-size="{$virtualizer.getTotalSize()}px">
  {#each $virtualizer.getVirtualItems() as vrow (vrow.key)}
    {@const message = messages[vrow.index]}
    {#if message}
    <div
      class="virtual-item"
      data-index={vrow.index}
      style:transform="translateY({vrow.start}px)"
      use:$virtualizer.measureElement
    >
      {@render messageBody(message)}
    </div>
    {/if}
  {/each}
  </div>
  {/if}

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

  /* The virtualizer's inner spacer. Reserves total scroll height
     (sum of measured + estimated item sizes) and serves as the
     positioning context for absolutely-placed virtual items.
     Thinking-bubble + empty-state live OUTSIDE this — they're flex
     siblings of `.virtual-inner` so the existing gap rule still
     applies between the last measured message and the thinking
     placeholder. */
  .virtual-inner {
    /* `.message-list` is a flex column; absolute children inside
       `.virtual-inner` don't contribute to its content size, so
       without `flex-shrink: 0` the flex layout collapses the
       container to 0 (or to whatever min equalization assigns)
       and `block-size` set inline becomes a no-op. The virtualizer
       still positions items at correct translateY offsets, but the
       scrollable area is wrong and the page rubberbands. */
    flex-shrink: 0;
    inline-size: 100%;
    position: relative;
  }

  .virtual-item {
    inset-block-start: 0;
    inset-inline: 0;
    /* The flex `gap` doesn't reach absolute children, so the
       between-message spacing has to live on each item. Bottom
       padding is included in the `measureElement` size, so the
       virtualizer's offset math accounts for it correctly. */
    padding-block-end: var(--size-4);
    position: absolute;
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

  /* Copy button on code blocks and tables.
     The outer .copyable-wrapper is the positioning context for the
     button — it never scrolls itself, so the button stays anchored
     to the trailing edge of the chat bubble while the user scrolls
     a wide table inside the inner .copyable-scroll. `<pre>` blocks
     have their own internal `overflow-x: auto` (see the
     markdown-body :global(pre) rule above), so they sit directly
     inside the wrapper with no inner scroll-div. */
  .message-content.markdown-body :global(.copyable-wrapper) {
    max-inline-size: 100%;
    position: relative;
  }

  .message-content.markdown-body :global(.copyable-scroll) {
    max-inline-size: 100%;
    overflow-x: auto;
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

  /* Table Actions dropdown — the trigger inherits .copy-btn chrome via
     the markup. .table-actions is the positioning anchor for the
     popover menu so the menu doesn't clip when the table scrolls. */
  .message-content.markdown-body :global(.table-actions) {
    inset-block-start: var(--size-1);
    inset-inline-end: var(--size-1);
    position: absolute;
    z-index: 1;
  }
  .message-content.markdown-body :global(.copyable-wrapper:hover .table-actions .copy-btn) {
    opacity: 1;
  }
  .message-content.markdown-body :global(.table-actions .copy-btn) {
    /* Keep the absolute positioning off the trigger itself — the
       wrapper above is now the positioned element. */
    inset-block-start: auto;
    inset-inline-end: auto;
    position: static;
  }

  .message-content.markdown-body :global(.table-actions-menu) {
    background-color: light-dark(hsl(0 0% 100%), hsl(220 12% 14%));
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    box-shadow: 0 4px 12px color-mix(in srgb, black, transparent 75%);
    display: flex;
    flex-direction: column;
    inset-block-start: calc(100% + 4px);
    inset-inline-end: 0;
    min-inline-size: 12rem;
    padding: 4px;
    position: absolute;
    z-index: 2;
  }
  /* Explicit override of `display: flex` above — without this, the
     [hidden] attribute (which we toggle via JS to open/close the
     menu) has no effect because the UA stylesheet's
     `[hidden] { display: none }` has equal specificity AND loses to
     a later-declared rule. Higher-specificity selector wins. */
  .message-content.markdown-body :global(.table-actions-menu[hidden]) {
    display: none;
  }
  .message-content.markdown-body :global(.table-actions-item) {
    background: none;
    border: 0;
    border-radius: var(--radius-1);
    color: var(--color-text);
    cursor: pointer;
    font: inherit;
    font-size: var(--font-size-2);
    padding: 6px 10px;
    text-align: start;
  }
  .message-content.markdown-body :global(.table-actions-item:hover) {
    background-color: color-mix(in srgb, var(--color-text), transparent 92%);
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
