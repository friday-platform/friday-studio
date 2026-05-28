<script lang="ts">
  import { scoreTitleMatch } from "../../chat/mention-text.ts";

  interface AccessibleChat {
    workspaceId: string;
    chatId: string;
    title: string | null;
    updatedAt: string;
  }

  interface Props {
    /** Current `@`-query (substring after the `@`, before the caret). */
    query: string;
    /** True while the popover should be visible. Owner closes on select / Escape / blur. */
    open: boolean;
    /** Caller picked a chat; the composer replaces the active query with `@<wsId>/<chatId>`. */
    onselect: (ref: { workspaceId: string; chatId: string; title: string }) => void;
    /** Caller wants the popover closed (Escape / outside click / no matches). */
    onclose: () => void;
  }

  let { query, open, onselect, onclose }: Props = $props();

  let chats = $state<AccessibleChat[]>([]);
  let fetchedAt = $state<number>(0);
  let loading = $state(false);
  let loadError = $state<string | null>(null);
  let highlighted = $state(0);

  // Refresh the chat list at most once every CACHE_TTL_MS — open the
  // popover within that window and we serve from memory; open it again
  // later and we re-fetch so a chat created in another tab / by an
  // agent shows up without a page reload. Inside the window we still
  // filter the in-memory list per keystroke; the cross-workspace
  // endpoint already returns a healthy slice ordered by updatedAt and
  // hitting it on every keystroke would beat NATS for what is
  // essentially client-side scoring work. See friday-studio-dbz.
  const CACHE_TTL_MS = 60_000;

  $effect(() => {
    if (!open) return;
    if (loading) return;
    if (fetchedAt > 0 && Date.now() - fetchedAt < CACHE_TTL_MS) return;
    loading = true;
    fetch("/api/daemon/api/me/chats?limit=200")
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<{ chats: AccessibleChat[] }>;
      })
      .then((body) => {
        chats = body.chats ?? [];
        fetchedAt = Date.now();
        loadError = null;
      })
      .catch((err: unknown) => {
        loadError = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        loading = false;
      });
  });

  const filtered = $derived.by(() => {
    if (chats.length === 0) return [] as AccessibleChat[];
    const q = query.trim();
    const scored = chats
      .map((c) => ({
        chat: c,
        score: scoreTitleMatch(c.title ?? "", q),
      }))
      .filter((entry) => entry.score !== Number.NEGATIVE_INFINITY)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        // Tie-break on recency.
        return Date.parse(b.chat.updatedAt) - Date.parse(a.chat.updatedAt);
      });
    return scored.slice(0, 8).map((entry) => entry.chat);
  });

  // Keep the highlight inside the visible window when the filter changes.
  $effect(() => {
    if (highlighted >= filtered.length) {
      highlighted = Math.max(0, filtered.length - 1);
    }
  });

  /**
   * Keyboard handlers exposed to the parent — the composer calls these
   * from its textarea keydown handler so navigation works in-place
   * without stealing focus. Returns `true` when the popover consumed
   * the event (parent should preventDefault).
   */
  export function handleKey(e: KeyboardEvent): boolean {
    if (!open) return false;
    // Escape + Enter MUST consume the event even in the empty/loading/
    // error state — otherwise Escape can't dismiss an open popover
    // and Enter would fall through to the composer's submit branch
    // while the popover is still painted on screen. See
    // friday-studio-ogy.
    if (e.key === "Escape") {
      onclose();
      return true;
    }
    if (filtered.length === 0) {
      // Consume Enter so the open-but-empty popover doesn't let a
      // half-typed `@xyz` get sent. ArrowUp/Down/Tab fall through
      // (nothing to navigate / select).
      return e.key === "Enter";
    }
    if (e.key === "ArrowDown") {
      highlighted = (highlighted + 1) % filtered.length;
      return true;
    }
    if (e.key === "ArrowUp") {
      highlighted = (highlighted - 1 + filtered.length) % filtered.length;
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      const pick = filtered[highlighted];
      if (pick) {
        onselect({
          workspaceId: pick.workspaceId,
          chatId: pick.chatId,
          title: pick.title ?? `${pick.workspaceId}/${pick.chatId}`,
        });
        return true;
      }
    }
    return false;
  }
</script>

{#if open}
  <div class="mention-popover" role="listbox" aria-label="Mention suggestions">
    {#if loading && fetchedAt === 0}
      <div class="empty">Loading chats…</div>
    {:else if loadError}
      <div class="empty error">Couldn't load chats: {loadError}</div>
    {:else if filtered.length === 0}
      <div class="empty">No matching chats</div>
    {:else}
      {#each filtered as chat, i (chat.workspaceId + "/" + chat.chatId)}
        <button
          type="button"
          class="row"
          class:active={i === highlighted}
          aria-selected={i === highlighted}
          onmouseenter={() => (highlighted = i)}
          onmousedown={(e) => {
            // Stop the textarea's onblur from firing — without
            // preventDefault here, mousedown blurs the textarea,
            // closeMentionPopover unmounts this {#if open} block,
            // and the queued click never reaches us. See
            // friday-studio-ogy.
            e.preventDefault();
          }}
          onclick={() =>
            onselect({
              workspaceId: chat.workspaceId,
              chatId: chat.chatId,
              title: chat.title ?? `${chat.workspaceId}/${chat.chatId}`,
            })}
        >
          <span class="title">{chat.title ?? "Untitled chat"}</span>
          <span class="ws">{chat.workspaceId}</span>
        </button>
      {/each}
    {/if}
  </div>
{/if}

<style>
  .mention-popover {
    background-color: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    box-shadow: 0 4px 12px rgb(0 0 0 / 25%);
    display: flex;
    flex-direction: column;
    inset-block-end: calc(100% + var(--size-2));
    inset-inline-start: 0;
    max-block-size: 240px;
    min-inline-size: 240px;
    overflow-y: auto;
    padding: var(--size-1);
    position: absolute;
    z-index: 50;
  }

  .row {
    align-items: baseline;
    background: transparent;
    border: none;
    border-radius: var(--radius-1);
    color: var(--color-text);
    cursor: pointer;
    display: flex;
    font-size: var(--font-size-1);
    gap: var(--size-2);
    justify-content: space-between;
    padding: var(--size-1) var(--size-2);
    text-align: start;
    inline-size: 100%;
  }

  .row.active,
  .row:hover {
    background-color: var(--color-surface-3);
  }

  .row .title {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .row .ws {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-0);
    flex-shrink: 0;
  }

  .empty {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-1);
    padding: var(--size-2);
    text-align: center;
  }

  .empty.error {
    color: var(--color-error);
  }
</style>
