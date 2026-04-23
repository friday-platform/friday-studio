<!--
  MCP Registry Import — command-palette style picker.

  Wide, left-aligned overlay for searching and installing servers from the
  upstream registry. No title block, no cancel button. Search is the entire
  interface. Install button is explicit, not hover-reveal.

  @component
  @prop open - Whether the picker is visible
  @prop onclose - Called when the picker should close (Escape, overlay click)
  @prop onInstall - Called with a registry canonical name to install
  @prop installing - Whether an install is in progress
-->

<script lang="ts">
  import { Button, IconSmall } from "@atlas/ui";
  import { createDialog } from "@melt-ui/svelte";
  import { createQuery } from "@tanstack/svelte-query";
  import { mcpQueries, type SearchResult } from "$lib/queries/mcp-queries";

  interface Props {
    open: boolean;
    onclose: () => void;
    onInstall: (registryName: string) => Promise<void>;
    installing: boolean;
  }

  let { open, onclose, onInstall, installing }: Props = $props();

  // ---------------------------------------------------------------------------
  // Melt UI dialog primitives — bypass @atlas/ui Dialog to control layout
  // ---------------------------------------------------------------------------

  const { elements, states } = createDialog({
    forceVisible: true,
    portal: "body",
    onOpenChange: ({ next }) => {
      if (!next) onclose();
      return next;
    },
  });

  const dialogOpen = states.open;
  const dialogPortalled = elements.portalled;
  const dialogOverlay = elements.overlay;
  const dialogContent = elements.content;

  $effect(() => {
    dialogOpen.set(open);
  });

  // ---------------------------------------------------------------------------
  // Search state
  // ---------------------------------------------------------------------------

  let searchInput = $state("");
  let searchQuery = $state("");
  let searchDebounce: ReturnType<typeof setTimeout> | undefined;
  let searchFocused = $state(false);
  let inputRef: HTMLInputElement | null = $state(null);

  function handleSearchInput(): void {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      searchQuery = searchInput.trim();
    }, 200);
  }

  $effect(() => {
    if (searchInput === "") {
      clearTimeout(searchDebounce);
      searchQuery = "";
    }
    return () => clearTimeout(searchDebounce);
  });

  $effect(() => {
    if (open && inputRef) {
      setTimeout(() => inputRef?.focus(), 50);
    }
  });

  // ---------------------------------------------------------------------------
  // Registry search
  // ---------------------------------------------------------------------------

  const searchResultsQuery = createQuery(() => mcpQueries.search(searchQuery));
  const registryResults = $derived(searchResultsQuery.data?.servers ?? []);

  // ---------------------------------------------------------------------------
  // Install
  // ---------------------------------------------------------------------------

  async function doInstall(result: SearchResult): Promise<void> {
    if (result.alreadyInstalled || installing) return;
    try {
      await onInstall(result.name);
    } catch {
      // Parent toasts success and failure; suppress unhandled rejection
    }
  }
</script>

{#if $dialogOpen}
  <div class="portal" {...$dialogPortalled} use:dialogPortalled>
    <div
      class="overlay"
      {...$dialogOverlay}
      use:dialogOverlay
      onclick={onclose}
    ></div>

    <div class="panel" {...$dialogContent} use:dialogContent>
      <!-- Search -->
      <div class="search-bar" class:focused={searchFocused}>
        <span class="search-icon"><IconSmall.Search /></span>
        <input
          bind:this={inputRef}
          type="text"
          placeholder="Search MCP registry (e.g. filesystem, linear…)"
          bind:value={searchInput}
          oninput={handleSearchInput}
          onfocus={() => (searchFocused = true)}
          onblur={() => (searchFocused = false)}
          autocomplete="off"
        />
        {#if searchResultsQuery.isLoading && searchQuery.length >= 2}
          <span class="search-spinner"><IconSmall.Progress /></span>
        {/if}
      </div>

      <!-- Results -->
      {#if searchQuery.length >= 2}
        <div class="results-scroll">
          {#if searchResultsQuery.isLoading}
            <div class="status">
              <span class="spin"><IconSmall.Progress /></span>
              Searching registry…
            </div>
          {:else if registryResults.length === 0}
            <div class="status empty">
              <p>No servers found for "{searchQuery}"</p>
            </div>
          {:else}
            <ul class="results-list">
              {#each registryResults as result (result.name)}
                {@const canInstall = !result.alreadyInstalled}
                <li class="result-row">
                  {#if canInstall}
                    <div class="result-item">
                      <div class="result-body">
                        <span class="result-name">{result.name}</span>
                        {#if result.description}
                          <p class="result-desc">{result.description}</p>
                        {/if}
                      </div>

                      <div class="result-actions">
                        {#if result.repositoryUrl}
                          <Button
                            variant="secondary"
                            size="icon"
                            href={result.repositoryUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label="Open repository"
                          >
                            <IconSmall.ExternalLink />
                          </Button>
                        {/if}
                        <Button
                          variant="primary"
                          size="small"
                          onclick={() => doInstall(result)}
                          disabled={installing}
                        >
                          {installing ? "…" : "Add"}
                        </Button>
                      </div>
                    </div>
                  {:else}
                    <div class="result-item installed">
                      <div class="result-body">
                        <span class="result-name">{result.name}</span>
                        {#if result.description}
                          <p class="result-desc">{result.description}</p>
                        {/if}
                      </div>
                      <span class="installed-badge">Added</span>
                    </div>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      {:else}
        <div class="status hint-text">Type to search the MCP registry</div>
      {/if}
    </div>
  </div>
{/if}

<style>
  /* ─── Portal & overlay ─────────────────────────────────────────────────── */

  .portal {
    align-items: flex-start;
    display: flex;
    inset: 0;
    justify-content: center;
    padding-block: 10vh;
    position: fixed;
    z-index: var(--layer-3);
  }

  .overlay {
    background: radial-gradient(
      circle farthest-side at 50% 50%,
      var(--color-surface-2) 0%,
      transparent 100%
    );
    inset: 0;
    position: absolute;
    z-index: -1;
  }

  /* ─── Panel ──────────────────────────────────────────────────────────────── */

  .panel {
    background: var(--color-surface-1);
    border-radius: var(--radius-6);
    box-shadow: var(--shadow-canvas);
    display: flex;
    flex-direction: column;
    inline-size: min(720px, 90vw);
    max-block-size: min(600px, 80vh);
    overflow: hidden;
    position: relative;
    text-align: start;
  }

  /* ─── Search bar ─────────────────────────────────────────────────────────── */

  .search-bar {
    align-items: center;
    background: var(--color-surface-2);
    border: none;
    border-radius: var(--radius-4);
    display: flex;
    flex-shrink: 0;
    gap: var(--size-2);
    margin: var(--size-4);
    padding: var(--size-3) var(--size-4);
  }

  .search-icon {
    color: color-mix(in srgb, var(--color-text), transparent 45%);
    display: flex;
    flex-shrink: 0;
  }

  .search-bar input {
    background: transparent;
    border: none;
    color: var(--color-text);
    font-family: inherit;
    font-size: var(--font-size-3);
    inline-size: 100%;
    outline: none;
  }

  .search-bar input::placeholder {
    color: color-mix(in srgb, var(--color-text), transparent 55%);
  }

  .search-spinner {
    animation: spin 2s linear infinite;
    color: color-mix(in srgb, var(--color-text), transparent 45%);
    display: flex;
    flex-shrink: 0;
  }

  @keyframes spin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }

  /* ─── Results scroll ─────────────────────────────────────────────────────── */

  .results-scroll {
    flex: 1;
    overflow-y: auto;
    scrollbar-width: thin;
  }

  .results-list {
    display: flex;
    flex-direction: column;
    list-style: none;
    margin: 0;
    padding: var(--size-1);
  }

  /* ─── Result item ────────────────────────────────────────────────────────── */

  .result-row {
    list-style: none;
  }

  .result-item {
    align-items: flex-start;
    background: none;
    border: none;
    border-radius: var(--radius-2);
    color: inherit;
    display: flex;
    gap: var(--size-3);
    inline-size: 100%;
    justify-content: space-between;
    outline: none;
    padding: var(--size-3);
    text-align: start;
  }

  .result-item.installed {
    opacity: 0.45;
  }

  .result-body {
    display: flex;
    flex-direction: column;
    gap: var(--size-0-5);
    min-inline-size: 0;
  }

  .result-name {
    color: var(--color-text);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
  }

  .result-desc {
    color: color-mix(in srgb, var(--color-text), transparent 35%);
    font-size: var(--font-size-2);
    line-height: 1.45;
    margin: 0;
  }

  /* ─── Action buttons ──────────────────────────────────────────────────────── */

  .result-actions {
    align-items: center;
    display: flex;
    flex-shrink: 0;
    gap: var(--size-2);
  }

  .installed-badge {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    flex-shrink: 0;
    font-size: var(--font-size-0);
    font-weight: var(--font-weight-5);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  /* ─── Status / empty ─────────────────────────────────────────────────────── */

  .status {
    align-items: center;
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    display: flex;
    flex-direction: column;
    font-size: var(--font-size-2);
    gap: var(--size-2);
    justify-content: center;
    padding: var(--size-8) var(--size-4);
    text-align: center;
  }

  .status.empty p {
    margin: 0;
  }

  .hint-text {
    color: color-mix(in srgb, var(--color-text), transparent 55%);
  }

  .spin {
    animation: spin 2s linear infinite;
    display: flex;
  }
</style>
