<script lang="ts">
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
  }

  const { workspaceId, currentChatId, onSelect }: Props = $props();

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
        chats = data.chats;
      } else {
        // Dedupe on append by id
        const seen = new Set(chats.map((c) => c.id));
        chats = [...chats, ...data.chats.filter((c) => !seen.has(c.id))];
      }
      nextCursor = data.nextCursor;
      hasMore = data.hasMore;
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

  // Poll every 15s for new messages (low cost — header+meta only). Skip the
  // tick when the tab is hidden so a backgrounded playground doesn't keep
  // hammering the daemon; refetch immediately on the visibilitychange back
  // to "visible" so the list isn't stale when the user returns.
  $effect(() => {
    if (!workspaceId) return;
    const interval = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") {
        return;
      }
      void fetchChats();
    }, 15_000);
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

  const visibleChats = $derived(
    expanded ? chats : chats.slice(0, INITIAL_LIMIT),
  );

  function formatRelativeTime(iso: string): string {
    const then = new Date(iso).getTime();
    const diffMs = Date.now() - then;
    const min = Math.floor(diffMs / 60_000);
    if (min < 1) return "just now";
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
</script>

<!--
  Spec: only render the panel when there's more than one chat. A single chat
  (the current one) means there's no history worth navigating to, so the
  panel adds clutter with no value. While the initial fetch is in flight
  `chats.length === 0` and the panel stays hidden; once fetched with ≥ 2
  entries it appears.
-->
{#if chats.length > 1}
  <aside class="chat-list-panel">
    <div class="chat-list-header">
      <h3>Chats</h3>
    </div>

    {#if error}
      <div class="list-error">{error}</div>
    {/if}

    <ul class="chat-list">
      {#each visibleChats as chat (chat.id)}
        {@const unread = isUnread(chat)}
        <li>
          <button
            class="chat-item"
            class:active={chat.id === currentChatId}
            class:unread
            onclick={() => handleClick(chat.id)}
          >
            <span class="item-dot" aria-hidden="true"></span>
            <div class="item-body">
              <div class="item-top">
                <span class="item-title">{chat.title ?? "Untitled"}</span>
                <span class="item-time">{formatRelativeTime(chat.updatedAt)}</span>
              </div>
              <div class="item-meta">
                <span class="source-badge source-{chat.source}">{sourceLabel(chat.source)}</span>
              </div>
            </div>
          </button>
        </li>
      {/each}
    </ul>

    {#if hasMore}
      <button class="load-more" onclick={loadMore} disabled={loading}>
        {loading ? "Loading…" : "Load more"}
      </button>
    {/if}
  </aside>
{/if}

<style>
  .chat-list-panel {
    background-color: var(--color-surface-2);
    border-inline-start: 1px solid var(--color-border-1);
    display: flex;
    flex-direction: column;
    inline-size: 280px;
    min-inline-size: 280px;
    overflow: hidden;
  }

  .chat-list-header {
    align-items: center;
    border-block-end: 1px solid var(--color-border-1);
    display: flex;
    flex-shrink: 0;
    justify-content: space-between;
    padding: var(--size-3);
  }

  .chat-list-header h3 {
    color: var(--color-text);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-6);
    margin: 0;
  }

  .list-error {
    color: var(--color-error);
    font-size: var(--font-size-1);
    padding: var(--size-3);
  }

  .list-empty {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-1);
    padding: var(--size-4);
    text-align: center;
  }

  .chat-list {
    display: flex;
    flex: 1;
    flex-direction: column;
    list-style: none;
    margin: 0;
    overflow-y: auto;
    padding: 0;
    scrollbar-width: thin;
  }

  .chat-item {
    align-items: flex-start;
    background: transparent;
    border: none;
    border-block-end: 1px solid color-mix(in srgb, var(--color-border-1), transparent 50%);
    color: var(--color-text);
    cursor: pointer;
    display: flex;
    font: inherit;
    gap: var(--size-2);
    inline-size: 100%;
    padding: var(--size-2) var(--size-3);
    text-align: start;
    transition: background-color 100ms ease;
  }

  .chat-item:hover {
    background-color: color-mix(in srgb, var(--color-text), transparent 92%);
  }

  .chat-item.active {
    background-color: color-mix(in srgb, var(--color-primary), transparent 85%);
  }

  .item-dot {
    background-color: transparent;
    block-size: 8px;
    border-radius: 50%;
    flex-shrink: 0;
    inline-size: 8px;
    margin-block-start: 6px;
  }

  .chat-item.unread .item-dot {
    animation: unread-pulse 1.8s ease-in-out infinite;
    background-color: var(--color-primary);
  }

  @keyframes unread-pulse {
    0%,
    100% {
      box-shadow: 0 0 0 0 color-mix(in srgb, var(--color-primary), transparent 60%);
      opacity: 1;
    }
    50% {
      box-shadow: 0 0 0 4px color-mix(in srgb, var(--color-primary), transparent 100%);
      opacity: 0.7;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .chat-item.unread .item-dot {
      animation: none;
    }
  }

  .item-body {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 2px;
    min-inline-size: 0;
  }

  .item-top {
    align-items: center;
    display: flex;
    gap: var(--size-2);
    justify-content: space-between;
  }

  .item-title {
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chat-item.unread .item-title {
    font-weight: var(--font-weight-6);
  }

  .item-time {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    flex-shrink: 0;
    font-size: var(--font-size-0);
  }

  .item-meta {
    display: flex;
    gap: var(--size-1);
  }

  .source-badge {
    border-radius: var(--radius-1);
    font-size: 10px;
    font-weight: var(--font-weight-6);
    letter-spacing: 0.02em;
    padding: 1px 5px;
    text-transform: uppercase;
  }

  .source-atlas {
    background-color: light-dark(hsl(220 60% 90%), hsl(220 30% 20%));
    color: light-dark(hsl(220 60% 35%), hsl(220 60% 75%));
  }

  .source-slack {
    background-color: light-dark(hsl(330 60% 90%), hsl(330 30% 20%));
    color: light-dark(hsl(330 60% 35%), hsl(330 60% 75%));
  }

  .source-discord {
    background-color: light-dark(hsl(240 60% 90%), hsl(240 30% 20%));
    color: light-dark(hsl(240 60% 35%), hsl(240 60% 75%));
  }

  .source-telegram {
    background-color: light-dark(hsl(200 70% 90%), hsl(200 30% 22%));
    color: light-dark(hsl(200 70% 35%), hsl(200 70% 75%));
  }

  .source-whatsapp {
    background-color: light-dark(hsl(142 60% 90%), hsl(142 30% 20%));
    color: light-dark(hsl(142 60% 30%), hsl(142 60% 70%));
  }

  .load-more {
    background-color: transparent;
    border: none;
    border-block-start: 1px solid var(--color-border-1);
    color: var(--color-primary);
    cursor: pointer;
    flex-shrink: 0;
    font-size: var(--font-size-1);
    padding: var(--size-2);
  }

  .load-more:disabled {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    cursor: default;
  }
</style>
