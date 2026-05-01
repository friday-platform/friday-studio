<script lang="ts">
  import { untrack } from "svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { createQuery } from "@tanstack/svelte-query";
  import { workspaceQueries } from "$lib/queries";

  interface Props {
    initialMode?: "chat" | "switcher";
    onclose: () => void;
  }

  let { initialMode = "chat", onclose }: Props = $props();

  const PERSONAL = "user";
  const COLORS: Record<string, string> = {
    yellow: "var(--yellow-2, #facc15)",
    purple: "var(--purple-2, #a78bfa)",
    red: "var(--red-2, #f87171)",
    blue: "var(--blue-2, #60a5fa)",
    green: "var(--green-2, #4ade80)",
    brown: "var(--brown-2, #a3824a)",
  };

  const workspacesQuery = createQuery(() => workspaceQueries.enriched());

  /** Personal pinned first, others in delivery order (matches sidebar). */
  const workspaces = $derived(
    [...(workspacesQuery.data ?? [])].sort((a, b) => {
      if (a.id === PERSONAL) return -1;
      if (b.id === PERSONAL) return 1;
      return 0;
    }),
  );

  let mode = $state<"chat" | "switcher">(untrack(() => initialMode));
  let target = $state<string>(page.params.workspaceId ?? PERSONAL);
  let value = $state("");
  let switcherQuery = $state("");
  let switcherIndex = $state(0);
  let textarea = $state<HTMLTextAreaElement | null>(null);
  let searchInput = $state<HTMLInputElement | null>(null);
  let listEl = $state<HTMLUListElement | null>(null);
  /** True until the first time we seed switcher selection for the current entry into switcher mode. */
  let needsSeed = $state(true);

  const targetWorkspace = $derived(workspaces.find((w) => w.id === target));
  const targetLabel = $derived(targetWorkspace?.displayName ?? (target === PERSONAL ? "Personal" : target));
  const targetColor = $derived(COLORS[targetWorkspace?.metadata?.color ?? "yellow"] ?? COLORS.yellow);

  const filteredWorkspaces = $derived.by(() => {
    const q = switcherQuery.trim().toLowerCase();
    if (!q) return workspaces;
    return workspaces.filter(
      (w) => w.displayName.toLowerCase().includes(q) || w.id.toLowerCase().includes(q),
    );
  });

  $effect(() => {
    if (mode === "chat") textarea?.focus();
    else searchInput?.focus();
  });

  $effect(() => {
    // Clamp index when filtered list shrinks.
    void filteredWorkspaces;
    if (switcherIndex >= filteredWorkspaces.length) switcherIndex = 0;
  });

  /**
   * Seed switcher selection at the current target the first time the list is
   * available after entering switcher mode. The `needsSeed` flag prevents
   * resetting the user's arrow-key choices once they start navigating.
   */
  $effect(() => {
    if (mode !== "switcher" || !needsSeed || filteredWorkspaces.length === 0) return;
    const idx = filteredWorkspaces.findIndex((w) => w.id === target);
    if (idx >= 0) switcherIndex = idx;
    needsSeed = false;
  });

  /** Keep the highlighted row inside the scroll viewport. */
  $effect(() => {
    if (mode !== "switcher" || !listEl) return;
    void switcherIndex;
    const child = listEl.children[switcherIndex] as HTMLElement | undefined;
    child?.scrollIntoView({ block: "nearest" });
  });

  function autosize() {
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }

  function submit() {
    const msg = value.trim();
    if (!msg) return;
    sessionStorage.setItem(`chat-seed-${target}`, msg);
    void goto(`/platform/${encodeURIComponent(target)}/chat`);
    onclose();
  }

  function selectWorkspace(id: string) {
    target = id;
    mode = "chat";
    switcherQuery = "";
    switcherIndex = 0;
  }

  function dotFor(color: string | undefined): string {
    return COLORS[color ?? "yellow"] ?? COLORS.yellow;
  }

  function handleChatKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onclose();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "p") {
      e.preventDefault();
      target = PERSONAL;
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "/") {
      e.preventDefault();
      mode = "switcher";
      needsSeed = true;
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  function handleSwitcherKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onclose();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "p") {
      e.preventDefault();
      selectWorkspace(PERSONAL);
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "/") {
      e.preventDefault();
      mode = "chat";
      return;
    }
    if (
      (e.metaKey || e.ctrlKey) &&
      e.key.toLowerCase() === "k" &&
      !e.altKey &&
      !e.shiftKey
    ) {
      e.preventDefault();
      mode = "chat";
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (filteredWorkspaces.length === 0) return;
      switcherIndex = (switcherIndex + 1) % filteredWorkspaces.length;
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (filteredWorkspaces.length === 0) return;
      switcherIndex =
        (switcherIndex - 1 + filteredWorkspaces.length) % filteredWorkspaces.length;
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const ws = filteredWorkspaces[switcherIndex];
      if (ws) selectWorkspace(ws.id);
    }
  }

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) onclose();
  }
</script>

<div class="palette-backdrop" role="presentation" onclick={handleBackdropClick}>
  <div class="palette" role="dialog" aria-label="Command palette">
    {#if mode === "chat"}
      <div class="target-row">
        <span class="target-info">
          <span class="dot" style:--dot-color={targetColor}></span>
          <span class="target-name">{targetLabel}</span>
        </span>
        {#if target !== PERSONAL}
          <button
            type="button"
            class="personal-hint"
            onclick={() => (target = PERSONAL)}
            title="Switch to personal"
          >
            Personal <kbd>⌘P</kbd>
          </button>
        {/if}
      </div>
      <textarea
        bind:this={textarea}
        bind:value
        oninput={autosize}
        onkeydown={handleChatKeydown}
        rows="1"
        placeholder="Ask anything…"
        spellcheck="false"
      ></textarea>
      <footer>
        <span class="hints">
          <kbd>↵</kbd> send ·
          <kbd>⇧↵</kbd> newline ·
          <kbd>⌘/</kbd> switch space ·
          <kbd>Esc</kbd> close
        </span>
      </footer>
    {:else}
      <input
        bind:this={searchInput}
        bind:value={switcherQuery}
        oninput={() => (switcherIndex = 0)}
        onkeydown={handleSwitcherKeydown}
        class="switcher-search"
        placeholder="Switch space…"
        spellcheck="false"
      />
      <ul class="switcher-list" role="listbox" bind:this={listEl}>
        {#each filteredWorkspaces as ws, i (ws.id)}
          <li>
            <button
              type="button"
              class="switcher-item"
              class:active={i === switcherIndex}
              onclick={() => selectWorkspace(ws.id)}
              onmouseenter={() => (switcherIndex = i)}
            >
              <span class="dot" style:--dot-color={dotFor(ws.metadata?.color)}></span>
              <span class="ws-name">{ws.displayName}</span>
              {#if ws.id === target}
                <span class="ws-badge current">current</span>
              {:else if ws.id === PERSONAL}
                <span class="ws-badge">personal</span>
              {/if}
            </button>
          </li>
        {:else}
          <li class="switcher-empty">
            {#if switcherQuery}
              No spaces match.
            {:else}
              Loading…
            {/if}
          </li>
        {/each}
      </ul>
      <footer>
        <span class="hints">
          <kbd>↑↓</kbd> navigate ·
          <kbd>↵</kbd> select ·
          <kbd>⌘P</kbd> personal ·
          <kbd>⌘/</kbd> back ·
          <kbd>Esc</kbd> close
        </span>
      </footer>
    {/if}
  </div>
</div>

<style>
  .palette-backdrop {
    background-color: color-mix(in srgb, var(--color-surface-2), transparent 20%);
    display: flex;
    inset: 0;
    justify-content: center;
    align-items: flex-start;
    padding-block-start: 18vh;
    position: fixed;
    z-index: 100;
  }

  .palette {
    background-color: var(--color-surface-1);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-4);
    box-shadow: 0 20px 60px -10px rgba(0, 0, 0, 0.4);
    display: flex;
    flex-direction: column;
    inline-size: min(640px, 90vw);
    overflow: hidden;
  }

  .target-row {
    align-items: center;
    border-block-end: 1px solid var(--color-border-1);
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    display: flex;
    flex-shrink: 0;
    font-size: var(--font-size-1);
    gap: var(--size-3);
    justify-content: space-between;
    padding: var(--size-2) var(--size-4);
  }

  .target-info {
    align-items: center;
    display: flex;
    gap: var(--size-2);
  }

  .target-name {
    color: var(--color-text);
    font-weight: var(--font-weight-6);
  }

  .dot {
    background-color: var(--dot-color);
    block-size: 8px;
    border-radius: 50%;
    display: inline-block;
    flex-shrink: 0;
    inline-size: 8px;
  }

  .personal-hint {
    align-items: center;
    background: transparent;
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    cursor: pointer;
    display: inline-flex;
    font-size: var(--font-size-1);
    gap: var(--size-1-5);
    padding: var(--size-1) var(--size-2);

    &:hover {
      background-color: var(--color-surface-2);
      color: var(--color-text);
    }
  }

  textarea {
    background: transparent;
    border: none;
    color: var(--color-text);
    font-family: var(--font-family-sans);
    font-size: var(--font-size-3);
    line-height: 1.4;
    max-block-size: 240px;
    min-block-size: 0;
    overflow-y: auto;
    padding: var(--size-4) var(--size-5);
    resize: none;

    &:focus {
      outline: none;
    }

    &::placeholder {
      color: color-mix(in srgb, var(--color-text), transparent 55%);
    }
  }

  .switcher-search {
    background: transparent;
    border: none;
    color: var(--color-text);
    font-family: var(--font-family-sans);
    font-size: var(--font-size-3);
    padding: var(--size-4) var(--size-5);

    &:focus {
      outline: none;
    }

    &::placeholder {
      color: color-mix(in srgb, var(--color-text), transparent 55%);
    }
  }

  .switcher-list {
    border-block-start: 1px solid var(--color-border-1);
    list-style: none;
    margin: 0;
    max-block-size: 320px;
    overflow-y: auto;
    padding: var(--size-1);
  }

  .switcher-item {
    align-items: center;
    background: transparent;
    border: none;
    border-radius: var(--radius-2);
    color: var(--color-text);
    cursor: pointer;
    display: flex;
    font-family: var(--font-family-sans);
    font-size: var(--font-size-2);
    gap: var(--size-2);
    inline-size: 100%;
    padding: var(--size-2) var(--size-3);
    text-align: start;

    &.active {
      background-color: var(--color-surface-2);
    }
  }

  .ws-name {
    flex: 1;
  }

  .ws-badge {
    background-color: var(--color-surface-2);
    border-radius: var(--radius-1);
    color: color-mix(in srgb, var(--color-text), transparent 35%);
    font-size: var(--font-size-0);
    padding: 0 var(--size-1-5);
  }

  .switcher-item.active .ws-badge {
    background-color: var(--color-surface-3);
  }

  .ws-badge.current {
    color: var(--color-text);
  }

  .switcher-empty {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-2);
    padding: var(--size-3);
    text-align: center;
  }

  footer {
    align-items: center;
    border-block-start: 1px solid var(--color-border-1);
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    display: flex;
    flex-shrink: 0;
    font-size: var(--font-size-1);
    gap: var(--size-3);
    padding: var(--size-2) var(--size-4);
  }

  .hints {
    display: flex;
    flex-wrap: wrap;
    gap: var(--size-2);
  }

  kbd {
    background-color: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-1);
    font-family: var(--font-family-mono);
    font-size: var(--font-size-0);
    padding: 0 var(--size-1);
  }
</style>
