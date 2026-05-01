<!--
  MCP Registry Import — command-palette style picker with custom server addition.

  Wide, left-aligned overlay for searching and installing servers from the
  upstream registry, plus adding custom HTTP or JSON-configured servers.

  @component
  @prop open - Whether the picker is visible
  @prop onclose - Called when the picker should close (Escape, overlay click)
  @prop onInstall - Called with a registry canonical name to install
  @prop installing - Whether an install is in progress
-->

<script lang="ts">
  import { goto } from "$app/navigation";
  import { Button, IconSmall, toast } from "@atlas/ui";
  import { createDialog } from "@melt-ui/svelte";
  import { createQuery } from "@tanstack/svelte-query";
  import { parseCustomMCPConfig, type ParseResult } from "@atlas/core/mcp-registry/custom-parser";
  import { mcpQueries, type SearchResult } from "$lib/queries/mcp-queries";
  import { useAddCustomMCPServer, type AddCustomMCPInput } from "$lib/queries/mcp";

  interface Props {
    open: boolean;
    onclose: () => void;
    onInstall: (registryName: string) => Promise<void>;
    installing: boolean;
  }

  let { open, onclose, onInstall, installing }: Props = $props();

  // ---------------------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------------------

  let activeTab = $state<"search" | "custom">("search");

  $effect(() => {
    if (open) {
      activeTab = "search";
      searchInput = "";
      searchQuery = "";
      customName = "";
      customDescription = "";
      customId = "";
      idManuallyEdited = false;
      httpUrl = "";
      jsonText = "";
      jsonParseResult = null;
    }
  });

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
    if (open && activeTab === "search" && inputRef) {
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

  // ---------------------------------------------------------------------------
  // Custom form state
  // ---------------------------------------------------------------------------

  let customName = $state("");
  let customDescription = $state("");
  let customId = $state("");
  let idManuallyEdited = $state(false);
  let httpUrl = $state("");
  let jsonText = $state("");
  let jsonParseResult = $state<ParseResult | null>(null);
  let jsonDebounce: ReturnType<typeof setTimeout> | undefined;

  const addCustomMut = useAddCustomMCPServer();

  function deriveId(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64);
  }

  $effect(() => {
    if (!idManuallyEdited) {
      customId = deriveId(customName);
    }
  });

  function handleIdInput(): void {
    idManuallyEdited = true;
  }

  function handleJsonInput(): void {
    clearTimeout(jsonDebounce);
    jsonDebounce = setTimeout(() => {
      parseJson();
    }, 300);
  }

  $effect(() => {
    if (jsonText === "") {
      clearTimeout(jsonDebounce);
      jsonParseResult = null;
    }
    return () => clearTimeout(jsonDebounce);
  });

  function parseJson(): void {
    if (jsonText.trim().length === 0) {
      jsonParseResult = null;
      return;
    }
    jsonParseResult = parseCustomMCPConfig(jsonText);
  }

  function handleJsonBlur(): void {
    clearTimeout(jsonDebounce);
    parseJson();
  }

  const hasHttpUrl = $derived(httpUrl.trim().length > 0);
  const hasJson = $derived(jsonText.trim().length > 0);
  const jsonValid = $derived(
    jsonParseResult !== null && jsonParseResult.success === true,
  );
  const canSubmitCustom = $derived(
    customName.trim().length > 0 &&
      ((hasHttpUrl && !hasJson) || (!hasHttpUrl && hasJson && jsonValid)) &&
      !addCustomMut.isPending,
  );

  async function handleSubmitCustom(): Promise<void> {
    if (!canSubmitCustom) return;

    const payload: AddCustomMCPInput = {
      name: customName.trim(),
    };

    const trimmedId = customId.trim();
    if (trimmedId) payload.id = trimmedId;

    const trimmedDescription = customDescription.trim();
    if (trimmedDescription) payload.description = trimmedDescription;

    if (hasHttpUrl) {
      payload.httpUrl = httpUrl.trim();
    } else if (hasJson && jsonParseResult && jsonParseResult.success) {
      payload.configJson = {
        transport: jsonParseResult.transport,
        envVars: jsonParseResult.envVars,
      };
    } else {
      return;
    }

    try {
      const result = await addCustomMut.mutateAsync(payload);
      onclose();
      goto(`/mcp/${result.server.id}`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toast({ title: "Add custom server failed", description: message, error: true });
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
      <!-- Tab bar -->
      <div class="tab-bar">
        <button
          type="button"
          class="tab"
          class:active={activeTab === "search"}
          onclick={() => (activeTab = "search")}
        >
          Search Registry
        </button>
        <button
          type="button"
          class="tab"
          class:active={activeTab === "custom"}
          onclick={() => (activeTab = "custom")}
        >
          Add Custom
        </button>
      </div>

      {#if activeTab === "search"}
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
                  {@const displayName = result.displayName ?? result.name}
                  <li class="result-row">
                    {#if canInstall}
                      <div class="result-item">
                        <div class="result-body">
                          <div class="result-name-row">
                            <span class="result-name">{displayName}</span>
                            {#if result.isOfficial}
                              <span class="official-badge">Official</span>
                            {/if}
                            <span class="version-badge">{result.version}</span>
                          </div>
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
                          <div class="result-name-row">
                            <span class="result-name">{displayName}</span>
                            {#if result.isOfficial}
                              <span class="official-badge">Official</span>
                            {/if}
                            <span class="version-badge">{result.version}</span>
                          </div>
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
      {:else}
        <!-- Custom form -->
        <div class="custom-form">
          <div class="field-group">
            <label class="field-label" for="custom-name">
              Name <span class="required">*</span>
            </label>
            <input
              id="custom-name"
              type="text"
              class="field-input"
              placeholder="My Custom Server"
              bind:value={customName}
            />
          </div>

          <div class="field-group">
            <label class="field-label" for="custom-description">Description</label>
            <input
              id="custom-description"
              type="text"
              class="field-input"
              placeholder="Optional description"
              bind:value={customDescription}
            />
          </div>

          <div class="field-group">
            <label class="field-label" for="custom-id">Server ID</label>
            <input
              id="custom-id"
              type="text"
              class="field-input"
              placeholder="auto-generated-from-name"
              bind:value={customId}
              oninput={handleIdInput}
            />
            <span class="field-hint">Lowercase, alphanumeric, dashes. Max 64 chars.</span>
          </div>

          <div class="field-group">
            <label class="field-label" for="custom-http-url">HTTP URL</label>
            <input
              id="custom-http-url"
              type="url"
              class="field-input"
              placeholder="https://example.com/mcp"
              bind:value={httpUrl}
            />
          </div>

          <div class="field-divider">
            <span class="divider-line"></span>
            <span class="divider-text">or</span>
            <span class="divider-line"></span>
          </div>

          <div class="field-group">
            <label class="field-label" for="custom-json">JSON Config</label>
            <textarea
              id="custom-json"
              class="field-textarea"
              placeholder="Paste Claude Desktop config, or bare stdio or HTTP JSON"
              bind:value={jsonText}
              oninput={handleJsonInput}
              onblur={handleJsonBlur}
            ></textarea>
            {#if jsonParseResult && !jsonParseResult.success}
              <p class="json-error">{jsonParseResult.reason}</p>
            {/if}
          </div>

          <div class="form-actions">
            <Button
              variant="primary"
              size="regular"
              onclick={handleSubmitCustom}
              disabled={!canSubmitCustom}
            >
              {addCustomMut.isPending ? "Adding…" : "Add Server"}
            </Button>
          </div>
        </div>
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

  /* ─── Tab bar ───────────────────────────────────────────────────────────── */

  .tab-bar {
    align-items: center;
    border-block-end: 1px solid var(--color-border-1);
    display: flex;
    flex-shrink: 0;
    gap: var(--size-1);
    padding: var(--size-3) var(--size-4) 0;
  }

  .tab {
    background: none;
    border: none;
    border-block-end: 2px solid transparent;
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    cursor: default;
    font-family: inherit;
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    padding: var(--size-2) var(--size-3);
    transition: all 150ms ease;
  }

  .tab.active {
    border-block-end-color: var(--color-text);
    color: var(--color-text);
  }

  .tab:not(.active):hover {
    color: color-mix(in srgb, var(--color-text), transparent 15%);
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

  .result-name-row {
    align-items: center;
    display: flex;
    gap: var(--size-2);
  }

  .result-name {
    color: var(--color-text);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
  }

  .official-badge {
    background: var(--color-accent);
    border-radius: var(--radius-1);
    color: var(--color-surface-1);
    font-size: var(--font-size-0);
    font-weight: var(--font-weight-5);
    letter-spacing: 0.02em;
    line-height: 1;
    padding: var(--size-0-5) var(--size-1-5);
  }

  .version-badge {
    background: var(--color-surface-3);
    border-radius: var(--radius-1);
    color: color-mix(in srgb, var(--color-text), transparent 35%);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: var(--font-size-0);
    font-weight: var(--font-weight-4);
    line-height: 1;
    padding: var(--size-0-5) var(--size-1-5);
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

  /* ─── Custom form ────────────────────────────────────────────────────────── */

  .custom-form {
    display: flex;
    flex-direction: column;
    flex: 1;
    gap: var(--size-3);
    overflow-y: auto;
    padding: var(--size-4);
    scrollbar-width: thin;
  }

  .field-group {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  .field-label {
    color: color-mix(in srgb, var(--color-text), transparent 20%);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
  }

  .required {
    color: var(--color-error);
  }

  .field-input {
    background: var(--color-surface-2);
    border: none;
    border-radius: var(--radius-2-5);
    color: var(--color-text);
    font-family: inherit;
    font-size: var(--font-size-2);
    padding: var(--size-2) var(--size-3);
  }

  .field-input::placeholder {
    color: color-mix(in srgb, var(--color-text), transparent 55%);
  }

  .field-input:focus-visible {
    outline: 1px solid var(--color-text);
  }

  .field-hint {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-1);
  }

  .field-divider {
    align-items: center;
    display: flex;
    gap: var(--size-2);
    padding-block: var(--size-1);
  }

  .divider-line {
    background: var(--color-border-1);
    flex: 1;
    block-size: 1px;
  }

  .divider-text {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-1);
    text-transform: uppercase;
  }

  .field-textarea {
    background: var(--color-surface-2);
    border: none;
    border-radius: var(--radius-2-5);
    color: var(--color-text);
    font-family: inherit;
    font-size: var(--font-size-2);
    min-block-size: 120px;
    padding: var(--size-2) var(--size-3);
    resize: vertical;
  }

  .field-textarea::placeholder {
    color: color-mix(in srgb, var(--color-text), transparent 55%);
  }

  .field-textarea:focus-visible {
    outline: 1px solid var(--color-text);
  }

  .json-error {
    color: var(--color-error);
    font-size: var(--font-size-1);
    margin: 0;
  }

  .form-actions {
    display: flex;
    justify-content: flex-end;
    margin-block-start: var(--size-2);
  }
</style>
