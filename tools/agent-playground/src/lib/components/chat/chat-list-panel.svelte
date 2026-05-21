<script lang="ts">
  import { Badge, IconSmall, SidebarNav } from "@atlas/ui";
  import { onMount } from "svelte";
  import { z } from "zod";

  const LastOpenedSchema = z.record(z.string(), z.string());

  interface ChatListEntry {
    id: string;
    title?: string;
    source: "atlas" | "slack" | "discord" | "telegram" | "whatsapp";
    color?: string;
    updatedAt: string;
  }

  interface Props {
    workspaceId: string;
    currentChatId: string;
    onSelect: (chatId: string) => void;
    /** Called after a successful delete with the deleted id and a neighbor
     * to switch to — older sibling first (since the list is newest-first),
     * newer if there's no older one. `null` means the list is now empty
     * and the parent should fall back to a fresh chat. */
    onDelete?: (chatId: string, nextChatId: string | null) => void;
  }

  const { workspaceId, currentChatId, onSelect, onDelete }: Props = $props();

  const INITIAL_LIMIT = 20;
  const EXPAND_BATCH = 20;
  const LAST_OPENED_KEY = "atlas:chat:lastOpened";

  let chats = $state<ChatListEntry[]>([]);
  let nextCursor = $state<number | null>(null);
  let hasMore = $state(false);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let expanded = $state(false);

  /** Record<chatId, ISO timestamp of last time user opened this chat>. */
  let lastOpened = $state<Record<string, string>>({});

  function loadLastOpened(): Record<string, string> {
    if (typeof localStorage === "undefined") return {};
    try {
      const raw = localStorage.getItem(LAST_OPENED_KEY);
      if (!raw) return {};
      const parsed = LastOpenedSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : {};
    } catch {
      return {};
    }
  }

  function saveLastOpened(data: Record<string, string>): void {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(LAST_OPENED_KEY, JSON.stringify(data));
    } catch {
      // ignore quota errors
    }
  }

  function markOpened(chatId: string): void {
    lastOpened = { ...lastOpened, [chatId]: new Date().toISOString() };
    saveLastOpened(lastOpened);
  }

  function isUnread(chat: ChatListEntry): boolean {
    if (chat.id === currentChatId) return false;
    const lastSeen = lastOpened[chat.id];
    if (!lastSeen) return true; // never opened
    return new Date(chat.updatedAt).getTime() > new Date(lastSeen).getTime();
  }

  async function fetchChats(cursor?: number): Promise<void> {
    loading = true;
    error = null;
    try {
      const params = new URLSearchParams({ limit: String(EXPAND_BATCH) });
      if (cursor !== undefined) params.set("cursor", String(cursor));
      const url = `/api/daemon/api/workspaces/${encodeURIComponent(workspaceId)}/chat?${params}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as {
        chats: ChatListEntry[];
        nextCursor: number | null;
        hasMore: boolean;
      };
      if (cursor === undefined) {
        // Initial load OR poll refresh. Merge-dedupe by id so a 15s poll
        // doesn't collapse entries the user loaded via "Load more": any
        // deeper page still in memory is preserved at its previous
        // position, while the fresh first page seeds new chats at the
        // top and updates metadata (title, updatedAt) for existing ones.
        // Fresh-page ordering wins at the top; stale deeper entries trail.
        const seen = new Set<string>();
        const merged: ChatListEntry[] = [];
        for (const c of data.chats) {
          merged.push(c);
          seen.add(c.id);
        }
        for (const c of chats) {
          if (!seen.has(c.id)) {
            merged.push(c);
            seen.add(c.id);
          }
        }
        chats = merged;
        // Only seed pagination on the very first fetch. Polls must NOT
        // overwrite nextCursor — the user may be paging deeper and
        // resetting to page-2 would break their next "Load more" click.
        if (nextCursor === null && !hasMore) {
          nextCursor = data.nextCursor;
          hasMore = data.hasMore;
        }
      } else {
        // Dedupe on append by id
        const seen = new Set(chats.map((c) => c.id));
        chats = [...chats, ...data.chats.filter((c) => !seen.has(c.id))];
        nextCursor = data.nextCursor;
        hasMore = data.hasMore;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  async function loadMore(): Promise<void> {
    if (nextCursor !== null) {
      expanded = true;
      await fetchChats(nextCursor);
    }
  }

  onMount(() => {
    lastOpened = loadLastOpened();
    if (currentChatId) markOpened(currentChatId);
    void fetchChats();
  });

  // Poll every 60s for new chats. Used to be 15s, but the active chat
  // already pushes its own updates through the SSE stream — the sidebar
  // poll only catches *other* chats arriving (rare in single-user
  // playground) and metadata drift on existing entries. Cutting to 60s
  // removes 3-of-every-4 sidebar reactive cascades during streaming with
  // no functional loss: the visibilitychange hook below refetches on
  // tab-return, so "I came back from a long break" still shows fresh
  // titles immediately. Hidden tabs still skip ticks entirely.
  $effect(() => {
    if (!workspaceId) return;
    const interval = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") {
        return;
      }
      void fetchChats();
    }, 60_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void fetchChats();
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisible);
    }
    return () => {
      clearInterval(interval);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisible);
      }
    };
  });

  const visibleChats = $derived(expanded ? chats : chats.slice(0, INITIAL_LIMIT));

  function formatRelativeTime(iso: string): string {
    const then = new Date(iso).getTime();
    const diffMs = Date.now() - then;
    const min = Math.floor(diffMs / 60_000);
    if (min < 1) return "now";
    if (min < 60) return `${min}m`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h`;
    const day = Math.floor(hr / 24);
    if (day < 7) return `${day}d`;
    const wk = Math.floor(day / 7);
    if (wk < 4) return `${wk}w`;
    const mo = Math.floor(day / 30);
    return `${mo}mo`;
  }

  function sourceVariant(
    source: ChatListEntry["source"],
  ): "info" | "warning" | "status" | "success" {
    switch (source) {
      case "slack":
        return "warning";
      case "discord":
        return "status";
      case "whatsapp":
        return "success";
      case "atlas":
      case "telegram":
      default:
        return "info";
    }
  }

  function sourceLabel(source: ChatListEntry["source"]): string {
    switch (source) {
      case "atlas":
        return "Web";
      case "slack":
        return "Slack";
      case "discord":
        return "Discord";
      case "telegram":
        return "Telegram";
      case "whatsapp":
        return "WhatsApp";
      default:
        return source;
    }
  }

  function handleClick(chatId: string): void {
    markOpened(chatId);
    onSelect(chatId);
  }

  /**
   * DELETE the chat on the daemon, then optimistically drop it from the
   * in-memory list. `event.stopPropagation` is required because the row
   * is also a click target — without it, deleting a chat would also
   * select it (and likely re-fetch a 404 right after).
   */
  async function handleDelete(event: MouseEvent, chat: ChatListEntry): Promise<void> {
    event.stopPropagation();
    if (!confirm(`Delete chat "${chat.title ?? "Untitled"}"? This can't be undone.`)) return;
    const url = `/api/daemon/api/workspaces/${encodeURIComponent(workspaceId)}/chat/${encodeURIComponent(chat.id)}`;
    try {
      const res = await fetch(url, { method: "DELETE" });
      // 204 on success, 404 if the chat vanished between render and click
      // (e.g. deleted from another tab). Either way the local list should
      // drop the row — a 404 is already the desired end state.
      if (!res.ok && res.status !== 404) {
        error = `Delete failed: HTTP ${res.status}`;
        return;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      return;
    }
    // Pick the neighbor BEFORE we mutate the list, so we can tell the
    // parent which chat to switch to if the deleted one was current.
    // List is newest-first, so index+1 = older. Prefer older so the user
    // keeps browsing backwards; fall back to newer when deleting the
    // oldest entry, and null when the list becomes empty.
    const idx = chats.findIndex((c) => c.id === chat.id);
    const next = idx >= 0 ? (chats[idx + 1] ?? chats[idx - 1] ?? null) : null;
    chats = chats.filter((c) => c.id !== chat.id);
    onDelete?.(chat.id, next ? next.id : null);
  }
</script>

<!--
  Panel renders on every workspace. Empty state (`chats.length === 0`) shows
  a short "No chats yet" hint so the affordance is visible before the first
  message is sent.
-->
<aside class="chat-list-panel">
  {#if error}
    <div class="list-error text-2xs">{error}</div>
  {/if}

  {#if chats.length === 0 && !loading}
    <p class="list-empty text-2xs">No chats yet — send a message to start one.</p>
  {/if}

  <div class="chat-list">
    <SidebarNav.Root>
      {#each visibleChats as chat (chat.id)}
        {@const unread = isUnread(chat)}
        <SidebarNav.Item active={chat.id === currentChatId} onclick={() => handleClick(chat.id)}>
          <div class="item-body" class:unread>
            <div class="item-top">
              <span class="item-title text-sm">{chat.title ?? "Untitled"}</span>
              {#if unread}
                <span class="item-unread" aria-hidden="true">*</span>
              {/if}
              <span class="item-time text-2xs">{formatRelativeTime(chat.updatedAt)}</span>
            </div>
            {#if chat.source !== "atlas"}
              <div class="item-meta">
                <Badge variant={sourceVariant(chat.source)}>{sourceLabel(chat.source)}</Badge>
              </div>
            {/if}
          </div>

          {#snippet actions()}
            <button
              type="button"
              class="chat-delete"
              onclick={(e) => handleDelete(e, chat)}
              aria-label="Delete chat {chat.title ?? 'Untitled'}"
              title="Delete chat"
            >
              <IconSmall.TrashBin />
            </button>
          {/snippet}
        </SidebarNav.Item>
      {/each}
    </SidebarNav.Root>
  </div>

  {#if hasMore}
    <div class="load-more-footer">
      <button class="load-more text-2xs" onclick={loadMore} disabled={loading}>
        {loading ? "Loading…" : "Load more"}
      </button>
    </div>
  {/if}
</aside>

<style>
  .chat-list-panel {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-block-size: 0;
    overflow: hidden;
    /* Positioning context for .load-more-footer. ListDetail's aside has
       no block-end padding, so this panel reaches the sidebar's bottom
       edge — the footer anchored here lands flush with it. */
    position: relative;
  }

  .list-error {
    color: var(--red-primary);
    padding-block: var(--size-3);
  }

  .list-empty {
    color: var(--text-faded);
    padding-block: var(--size-4);
    text-align: center;
  }

  .chat-list {
    display: flex;
    flex: 1;
    flex-direction: column;
    /* Without an explicit min-height: 0 a flex item won't shrink below
       its content size, which kills the inner overflow-y: auto scroll
       when the parent column has a finite height. */
    min-block-size: 0;
    overflow-y: auto;
    /* Bottom padding clears the absolutely-positioned .load-more-footer
       so the last chat row can scroll fully into view above it. Matches
       the footer's total height: pill + its block padding. */
    padding-block-end: calc(var(--size-7) + var(--size-4) * 2);
    scrollbar-width: thin;
  }

  /* The chat row content is a column (title row + optional source badge).
     It overrides the default centered row layout coming from SidebarNav's
     trigger so multi-line content sits flush-left. */
  .item-body {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 2px;
    min-inline-size: 0;
    padding-block: var(--size-1);
  }

  .item-top {
    align-items: center;
    display: flex;
    gap: var(--size-2);
  }

  .item-title {
    flex: 1;
    font-weight: var(--font-weight-5);
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .item-body.unread .item-title {
    font-weight: var(--font-weight-6);
  }

  .item-unread {
    color: var(--blue-primary);
    flex-shrink: 0;
    font-weight: var(--font-weight-6);
    /* Tighter gap between title and asterisk than between asterisk and
       the time slot, so the asterisk reads as part of the title. */
    margin-inline-start: calc(var(--size-2) * -1 + var(--size-1));
    /* The asterisk glyph sits in the upper half of its em-box; nudge it
       down so it optically centers with the title text rather than
       floating near the cap line. */
    transform: translateY(0.2em);
  }

  .item-time {
    color: var(--text-faded);
    flex-shrink: 0;
    /* Fixed-width slot so the on-hover trash icon (same width, centered)
       swaps in over the same visual span without shifting. Opacity is
       driven by `--sidebar-nav-row-hover` from SidebarNav.Item so the
       hover-swap covers actions area too, not just the trigger. */
    inline-size: 24px;
    opacity: calc(1 - var(--sidebar-nav-row-hover, 0));
    text-align: center;
    transition: opacity 150ms ease;
  }

  .item-meta {
    display: flex;
    gap: var(--size-1);
  }

  /* Action button: starts hidden, fades in when the row is hovered.
     Driven by SidebarNav.Item's `--sidebar-nav-row-hover` so the swap is
     symmetric with `.item-time`. `pointer-events` flips to auto only when
     the row is hovered so the invisible button isn't a click target. */
  .chat-delete {
    align-items: center;
    background: transparent;
    border: none;
    border-radius: var(--radius-2);
    color: var(--text-faded);
    cursor: pointer;
    display: flex;
    /* Match .item-time's fixed-width slot so the icon is centered on the
       same span the time was occupying — both elements share a 24px box. */
    inline-size: 24px;
    block-size: 100%;
    justify-content: center;
    opacity: var(--sidebar-nav-row-hover, 0);
    pointer-events: var(--sidebar-nav-row-hover-pe, none);
    transition:
      opacity 150ms ease,
      color 100ms ease;
  }

  .chat-delete:focus-visible {
    opacity: 1;
    pointer-events: auto;
  }

  .chat-delete:hover,
  .chat-delete:focus-visible {
    color: var(--red-primary);
  }

  /* Absolutely positioned against .chat-list-panel (its positioned
     ancestor). Since ListDetail's aside has no block-end padding, the
     panel reaches the sidebar's bottom edge and this footer lands flush
     with it — lined up with the workspace-sidebar Docs footer. The
     gradient fades the scrolled chat rows underneath; pointer-events:
     none lets wheel + clicks pass through everywhere except the pill. */
  .load-more-footer {
    align-items: center;
    background: linear-gradient(to top, var(--surface-dark) 60%, transparent);
    display: flex;
    inset-block-end: 0;
    inset-inline: 0;
    justify-content: center;
    padding-block: var(--size-4);
    pointer-events: none;
    position: absolute;
  }

  .load-more {
    align-items: center;
    background-color: var(--surface);
    block-size: var(--size-7);
    border: none;
    border-radius: var(--radius-round);
    color: inherit;
    cursor: pointer;
    display: inline-flex;
    flex-shrink: 0;
    font-weight: var(--font-weight-5-5);
    justify-content: center;
    padding-inline: var(--size-3);
    pointer-events: auto;
    transition: background-color 200ms ease;
  }

  .load-more:hover:not(:disabled) {
    background-color: var(--highlight-bright);
  }

  .load-more:disabled {
    cursor: default;
    opacity: 0.6;
  }
</style>
