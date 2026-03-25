<script lang="ts">
  import { browser } from "$app/environment";
  import { page } from "$app/state";
  import { categories, isRelevant, relevanceScore } from "$lib/cheatsheet-commands";
  import type { Restty as ResttyType } from "restty";

  interface Props {
    onclose: () => void;
  }

  let { onclose }: Props = $props();

  let search = $state("");
  let ptyAvailable = $state(false);
  let showAllPages = $state(false);
  let searchInput = $state<HTMLInputElement | null>(null);

  /** Terminal panel state */
  let terminalOpen = $state(false);
  let terminalContainer = $state<HTMLDivElement | null>(null);
  let resttyInstance: ResttyType | null = null;
  let ptySocket: WebSocket | null = null;
  let pendingCommand: string | null = null;
  let terminalMounted = false;

  const pathname = $derived(page.url.pathname);

  /** PTY WebSocket URL — goes through the Vite proxy at /pty-proxy */
  function getPtyWsUrl(): string {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.host}/pty-proxy/pty`;
  }

  // Check PTY server availability via the Vite proxy
  if (browser) {
    fetch("/pty-proxy/health")
      .then((r) => {
        if (r.ok) ptyAvailable = true;
      })
      .catch(() => {
        // PTY server not available — copy-only mode
      });
  }

  // Focus search input on mount
  $effect(() => {
    if (searchInput) {
      searchInput.focus();
    }
  });

  // Mount/unmount restty when terminal panel opens/closes
  $effect(() => {
    if (terminalOpen && terminalContainer && browser && !terminalMounted) {
      terminalMounted = true;
      mountTerminal();
    }

    return () => {
      if (resttyInstance) {
        resttyInstance.destroy();
        resttyInstance = null;
      }
      ptySocket = null;
      terminalMounted = false;
    };
  });

  async function mountTerminal() {
    // Prevent restty from triggering the browser "Use local fonts?" permission popup.
    // Stub the Local Font Access API so it silently returns an empty list.
    if (!("queryLocalFonts" in window) || window.queryLocalFonts) {
      // @ts-expect-error Local Font Access API (Chrome 103+) — not in TS DOM lib yet
      window.queryLocalFonts = async () => [];
    }

    // Intercept WebSocket creation to capture restty's PTY connection.
    // We need direct WS access to paste commands WITHOUT a trailing \r
    // (restty's sendInput appends \r which auto-executes the command).
    const OrigWS = window.WebSocket;
    window.WebSocket = function (...args: ConstructorParameters<typeof WebSocket>) {
      const ws = new OrigWS(...args);
      const url = typeof args[0] === "string" ? args[0] : (args[0]?.toString() ?? "");
      if (url.includes("/pty")) {
        ptySocket = ws;
      }
      return ws;
    } as unknown as typeof WebSocket;
    window.WebSocket.prototype = OrigWS.prototype;

    const { Restty } = await import("restty");

    // Guard: component may have been destroyed during async import
    if (!terminalContainer || !terminalOpen) {
      window.WebSocket = OrigWS;
      return;
    }

    resttyInstance = new Restty({
      root: terminalContainer,
      appOptions: { renderer: "auto", fontSize: 13, autoResize: true },
    });

    // connectPty creates the WebSocket — our patched constructor captures it
    resttyInstance.connectPty(getPtyWsUrl());
    // Restore original constructor now that we've captured the PTY socket
    window.WebSocket = OrigWS;

    // Flush any pending command once the shell prompt arrives.
    if (pendingCommand) {
      const cmd = pendingCommand;
      pendingCommand = null;
      waitForShellPrompt(() => pasteToTerminal(cmd));
    }
  }

  /**
   * Paste text into the terminal WITHOUT executing.
   * Writes directly to the PTY WebSocket, bypassing restty's sendInput
   * which appends \r (causing auto-execution).
   */
  function pasteToTerminal(text: string) {
    if (ptySocket && ptySocket.readyState === WebSocket.OPEN) {
      ptySocket.send(JSON.stringify({ type: "input", data: text }));
    }
  }

  /**
   * Wait for the shell to actually output its prompt before calling `fn`.
   * Listens for binary WebSocket messages (PTY output) instead of polling
   * the canvas, so it works regardless of shell startup speed.
   */
  function waitForShellPrompt(fn: () => void) {
    if (!ptySocket) return;
    let done = false;
    const onMessage = (e: MessageEvent) => {
      // Binary messages = PTY output. The first one containing a prompt
      // character ($ or %) means the shell is ready for input.
      if (done) return;
      if (typeof e.data !== "string") {
        done = true;
        ptySocket?.removeEventListener("message", onMessage);
        // Small delay to let restty render the prompt before we paste
        setTimeout(() => {
          fn();
          focusTerminal();
        }, 50);
      }
    };
    ptySocket.addEventListener("message", onMessage);
    // Safety timeout — give up after 5s
    setTimeout(() => {
      if (!done) {
        done = true;
        ptySocket?.removeEventListener("message", onMessage);
        fn();
        focusTerminal();
      }
    }, 5000);
  }

  /** Focus the terminal so it receives keyboard input. */
  function focusTerminal() {
    if (!terminalContainer) return;
    // restty captures keyboard via a hidden textarea or the canvas itself
    const target =
      terminalContainer.querySelector("textarea") ?? terminalContainer.querySelector("canvas");
    if (target instanceof HTMLElement) {
      target.tabIndex = 0;
      target.focus();
    }
  }

  /** Filtered categories, sorted by relevance to the current page */
  const filteredCategories = $derived.by(() => {
    const q = search.toLowerCase().trim();
    return categories
      .map((cat) => {
        const cmds = cat.commands.filter((cmd) => {
          // Page relevance filter
          if (!showAllPages && !isRelevant(cmd, pathname)) return false;
          // Search filter
          if (q) {
            return (
              cmd.command.toLowerCase().includes(q) ||
              cmd.description.toLowerCase().includes(q) ||
              cat.name.toLowerCase().includes(q)
            );
          }
          return true;
        });
        // Max relevance score across commands in this category
        const score = cmds.reduce((best, cmd) => Math.max(best, relevanceScore(cmd, pathname)), 0);
        return { ...cat, commands: cmds, score };
      })
      .filter((cat) => cat.commands.length > 0)
      .sort((a, b) => b.score - a.score);
  });

  const totalVisible = $derived(
    filteredCategories.reduce((sum, cat) => sum + cat.commands.length, 0),
  );

  /** Flat list of visible commands for keyboard navigation */
  const flatCommands = $derived(filteredCategories.flatMap((cat) => cat.commands));

  /** Keyboard selection index (-1 = nothing selected) */
  let selectedIndex = $state(-1);

  // Reset selection when the filtered list changes
  $effect(() => {
    // Reference flatCommands.length to track changes
    if (flatCommands.length >= 0) {
      selectedIndex = -1;
    }
  });

  /** Act on the selected command: run if PTY available and allowed, otherwise copy */
  function actOnSelected() {
    if (selectedIndex < 0 || selectedIndex >= flatCommands.length) return;
    const cmd = flatCommands[selectedIndex];
    if (ptyAvailable && !cmd.copyOnly) {
      dropToTerminal(cmd.command);
    } else {
      copyCommand(cmd.command);
    }
  }

  /** Scroll the selected row into view */
  function scrollSelectedIntoView() {
    requestAnimationFrame(() => {
      const row = document.querySelector(".command-row.selected");
      if (row) row.scrollIntoView({ block: "nearest" });
    });
  }

  /** Get flat index from category + command indices */
  function getFlatIndex(catIdx: number, cmdIdx: number): number {
    let offset = 0;
    for (let i = 0; i < catIdx; i++) {
      offset += filteredCategories[i].commands.length;
    }
    return offset + cmdIdx;
  }

  function handleSearchKeydown(e: KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (flatCommands.length > 0) {
        selectedIndex = selectedIndex < flatCommands.length - 1 ? selectedIndex + 1 : 0;
        scrollSelectedIntoView();
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (flatCommands.length > 0) {
        selectedIndex = selectedIndex > 0 ? selectedIndex - 1 : flatCommands.length - 1;
        scrollSelectedIntoView();
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      actOnSelected();
    }
  }

  async function copyCommand(command: string) {
    try {
      await navigator.clipboard.writeText(command);
    } catch {
      // Fallback: select text — user can Cmd+C
    }
  }

  /** Drop command into the terminal. Does NOT execute — just pastes text. */
  function dropToTerminal(command: string) {
    terminalOpen = true;
    if (ptySocket && ptySocket.readyState === WebSocket.OPEN) {
      pasteToTerminal(command);
      requestAnimationFrame(() => focusTerminal());
    } else {
      pendingCommand = command;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      if (terminalOpen) {
        terminalOpen = false;
      } else {
        onclose();
      }
    }
  }

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) {
      onclose();
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="cheatsheet-backdrop" role="presentation" onclick={handleBackdropClick}>
  <div class="cheatsheet" role="dialog" aria-label="CLI Cheatsheet">
    <header class="cheatsheet-header">
      <div class="header-top">
        <h2>CLI Cheatsheet</h2>
        <div class="header-right">
          {#if ptyAvailable}
            <span class="exec-badge available">Terminal</span>
          {:else}
            <span class="exec-badge unavailable">Copy only</span>
          {/if}
          <kbd>Esc</kbd>
        </div>
      </div>

      <div class="header-controls">
        <input
          bind:this={searchInput}
          bind:value={search}
          onkeydown={handleSearchKeydown}
          type="text"
          class="search-input"
          placeholder="Search commands..."
        />
        <label class="toggle-label">
          <input type="checkbox" bind:checked={showAllPages} />
          Show all
        </label>
      </div>

      {#if !showAllPages}
        <p class="context-hint">
          Showing commands for <code>{pathname}</code>
          — toggle "Show all" for everything
        </p>
      {/if}
    </header>

    <div class="cheatsheet-body">
      {#if filteredCategories.length === 0}
        <p class="empty-state">
          {search ? "No commands match your search" : "No contextual commands for this page"}
        </p>
      {:else}
        {#each filteredCategories as category, catIdx (category.name)}
          <section class="category">
            <h3>{category.name}</h3>
            <div class="command-list" role="listbox">
              {#each category.commands as cmd, cmdIdx (cmd.command)}
                {@const flatIdx = getFlatIndex(catIdx, cmdIdx)}
                <div
                  class="command-row"
                  class:selected={flatIdx === selectedIndex}
                  onclick={() => {
                    selectedIndex = flatIdx;
                    actOnSelected();
                  }}
                  onkeydown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      selectedIndex = flatIdx;
                      actOnSelected();
                    }
                  }}
                  role="option"
                  tabindex={flatIdx === selectedIndex ? 0 : -1}
                  aria-selected={flatIdx === selectedIndex}
                >
                  <div class="command-info">
                    <code class="command-text">{cmd.command}</code>
                    <span class="command-desc">{cmd.description}</span>
                  </div>
                  <div class="command-actions">
                    <button
                      class="action-btn"
                      onclick={(e) => {
                        e.stopPropagation();
                        copyCommand(cmd.command);
                      }}
                      title="Copy to clipboard"
                    >
                      Copy
                    </button>
                    {#if ptyAvailable && !cmd.copyOnly}
                      <button
                        class="action-btn run-btn"
                        onclick={(e) => {
                          e.stopPropagation();
                          dropToTerminal(cmd.command);
                        }}
                        title="Drop to terminal"
                      >
                        Run
                      </button>
                    {/if}
                  </div>
                </div>
              {/each}
            </div>
          </section>
        {/each}
      {/if}
    </div>

    {#if terminalOpen}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="terminal-panel" onclick={focusTerminal}>
        <header class="terminal-header">
          <span class="terminal-label">Terminal</span>
          <span class="terminal-spacer"></span>
        </header>
        <div class="terminal-container" bind:this={terminalContainer}></div>
      </div>
    {/if}

    <footer class="cheatsheet-footer">
      <span class="footer-hint">{totalVisible} commands</span>
      <span class="footer-hint">
        <kbd>&uarr;</kbd>
        <kbd>&darr;</kbd>
        navigate ·
        <kbd>Enter</kbd>
        {ptyAvailable ? "run" : "copy"} ·
        <kbd>Esc</kbd>
        close
      </span>
    </footer>
  </div>
</div>

<style>
  .cheatsheet-backdrop {
    background-color: color-mix(in srgb, var(--color-surface-2), transparent 20%);
    display: flex;
    inset: 0;
    justify-content: center;
    align-items: flex-start;
    padding-block-start: 8vh;
    position: fixed;
    z-index: 100;
  }

  .cheatsheet {
    background-color: var(--color-surface-1);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-4);
    box-shadow: 0 20px 60px -10px rgba(0, 0, 0, 0.4);
    display: flex;
    flex-direction: column;
    inline-size: min(720px, 90vw);
    max-block-size: 75vh;
    overflow: hidden;
  }

  .cheatsheet-header {
    border-block-end: 1px solid var(--color-border-1);
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    gap: var(--size-2);
    padding: var(--size-4) var(--size-5);
  }

  .header-top {
    align-items: center;
    display: flex;
    justify-content: space-between;

    h2 {
      font-size: var(--font-size-5);
      font-weight: var(--font-weight-6);
    }
  }

  .header-right {
    align-items: center;
    display: flex;
    gap: var(--size-3);
  }

  .header-controls {
    align-items: center;
    display: flex;
    gap: var(--size-3);
  }

  .search-input {
    background-color: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    color: var(--color-text);
    flex: 1;
    font-family: var(--font-family-sans);
    font-size: var(--font-size-2);
    padding: var(--size-1-5) var(--size-3);

    &:focus {
      border-color: color-mix(in srgb, var(--color-text), transparent 60%);
      outline: none;
    }
  }

  .toggle-label {
    align-items: center;
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    cursor: pointer;
    display: flex;
    flex-shrink: 0;
    font-size: var(--font-size-1);
    gap: var(--size-1);
    user-select: none;
  }

  .context-hint {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-1);

    code {
      background-color: var(--color-surface-2);
      border-radius: var(--radius-1);
      font-size: var(--font-size-1);
      padding: var(--size-0-5) var(--size-1);
    }
  }

  .exec-badge {
    border-radius: var(--radius-1);
    font-size: var(--font-size-0);
    font-weight: var(--font-weight-5);
    letter-spacing: var(--font-letterspacing-1);
    padding: var(--size-0-5) var(--size-2);
    text-transform: uppercase;
  }

  .exec-badge.available {
    background-color: color-mix(in srgb, var(--color-success), transparent 85%);
    color: var(--color-success);
  }

  .exec-badge.unavailable {
    background-color: color-mix(in srgb, var(--color-text), transparent 90%);
    color: color-mix(in srgb, var(--color-text), transparent 40%);
  }

  kbd {
    background-color: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-1);
    font-family: var(--font-family-sans);
    font-size: var(--font-size-0);
    padding: var(--size-0-5) var(--size-1);
  }

  .cheatsheet-body {
    display: flex;
    flex-direction: column;
    gap: var(--size-4);
    overflow-y: auto;
    padding: var(--size-4) var(--size-5);
    scrollbar-width: thin;
  }

  .empty-state {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-3);
    padding: var(--size-8);
    text-align: center;
  }

  .category {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);

    h3 {
      color: color-mix(in srgb, var(--color-text), transparent 40%);
      font-size: var(--font-size-1);
      font-weight: var(--font-weight-5);
      letter-spacing: var(--font-letterspacing-2);
      text-transform: uppercase;
    }
  }

  .command-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  .command-row {
    align-items: center;
    border-radius: var(--radius-2);
    display: flex;
    gap: var(--size-3);
    justify-content: space-between;
    padding: var(--size-2) var(--size-2-5);
    transition: background-color 100ms ease;

    &:hover {
      background-color: var(--color-surface-2);
    }

    &.selected {
      background-color: color-mix(in srgb, var(--color-success), transparent 90%);
      outline: 1px solid color-mix(in srgb, var(--color-success), transparent 70%);
    }
  }

  .command-info {
    display: flex;
    flex-direction: column;
    gap: var(--size-0-5);
    min-inline-size: 0;
  }

  .command-text {
    color: var(--color-text);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .command-desc {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-1);
  }

  .command-actions {
    display: flex;
    flex-shrink: 0;
    gap: var(--size-1);
  }

  .action-btn {
    all: unset;
    background-color: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-1);
    color: color-mix(in srgb, var(--color-text), transparent 20%);
    cursor: pointer;
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    padding: var(--size-0-5) var(--size-2);
    transition: background-color 100ms ease;

    &:hover {
      background-color: var(--color-highlight-1);
    }

    &:disabled {
      cursor: default;
      opacity: 0.5;
    }
  }

  .run-btn {
    background-color: color-mix(in srgb, var(--color-success), transparent 85%);
    border-color: color-mix(in srgb, var(--color-success), transparent 70%);
    color: var(--color-success);

    &:hover {
      background-color: color-mix(in srgb, var(--color-success), transparent 75%);
    }
  }

  /* Terminal panel — restty mounts here */
  .terminal-panel {
    border-block-start: 1px solid var(--color-border-1);
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    block-size: 300px;
  }

  .terminal-header {
    align-items: center;
    background-color: color-mix(in srgb, #000, transparent 60%);
    display: flex;
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    gap: var(--size-2);
    padding: var(--size-1-5) var(--size-3);
  }

  .terminal-label {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
  }

  .terminal-spacer {
    flex: 1;
  }

  .terminal-container {
    background-color: #1a1a2e;
    flex: 1;
    min-block-size: 0;
    overflow: hidden;
  }

  .cheatsheet-footer {
    align-items: center;
    border-block-start: 1px solid var(--color-border-1);
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    display: flex;
    flex-shrink: 0;
    font-size: var(--font-size-1);
    justify-content: space-between;
    padding: var(--size-2) var(--size-5);
  }

  .footer-hint {
    display: flex;
    align-items: center;
    gap: var(--size-1);
  }
</style>
