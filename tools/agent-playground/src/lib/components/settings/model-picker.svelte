<!--
  Model picker flyout — opens from the settings page when the user clicks
  a chain slot. Two-step selection:
    1. Provider pills across the top filter the model list. "All" shows
       every provider grouped; clicking a specific provider narrows the
       list to just that provider's models.
    2. A search box does substring match against model id + display name
       + provider name.

  When the user clicks a locked provider (no API key), the body is
  replaced by an inline "Save & unlock" banner where they can paste the
  key and save it directly — no page navigation — so the flow from
  "oh I need Google" to "Google is picked" stays one modal deep.

  Duplicate detection, default-chain fallback, and save-to-friday.yml
  all live in the parent page; this component only exposes an `onSelect`
  callback with a `ModelChoice | null` payload.
-->
<script lang="ts">
  import ProviderMark from "./provider-mark.svelte";

  interface Model {
    id: string;
    displayName: string;
  }
  interface ProviderMeta {
    name: string;
    letter: string;
    keyPrefix: string | null;
    helpUrl: string | null;
  }
  interface CatalogEntry {
    provider: string;
    credentialConfigured: boolean;
    credentialEnvVar: string | null;
    meta: ProviderMeta;
    models: Model[];
    error?: string;
  }
  export interface ModelChoice {
    provider: string;
    modelId: string;
  }

  interface Props {
    roleTitle: string;
    slotLabel: string;
    /** The model currently in this slot, if any. Used to mark the active
     * option with a checkmark so the user sees "this is what's there". */
    current: ModelChoice | null;
    /** Whether the slot represents "primary only, no fallbacks yet". When
     * true, picking `null` ("Use default chain") is meaningful; otherwise
     * the default option is hidden because the user is explicitly editing
     * a specific slot in an override chain. */
    allowDefault: boolean;
    catalog: CatalogEntry[];
    /** Save an API key inline and flip a provider from locked → unlocked.
     * Returns the updated catalog entries so the picker can reflect the
     * new state without a full-page reload. */
    saveApiKey: (envVar: string, value: string) => Promise<CatalogEntry[] | null>;
    onSelect: (choice: ModelChoice | null) => void;
    onClose: () => void;
  }

  const {
    roleTitle,
    slotLabel,
    current,
    allowDefault,
    catalog: initialCatalog,
    saveApiKey,
    onSelect,
    onClose,
  }: Props = $props();

  // We mutate the local copy when an inline "Save & unlock" succeeds so
  // the pills + banner flip to the new state immediately. The parent
  // still gets the refreshed catalog via saveApiKey's return value.
  let catalog = $state(initialCatalog);

  let search = $state("");
  let activeProvider = $state<string | null>(null);
  // Per-provider inline key input buffer. Separate entries so switching
  // providers while typing doesn't wipe someone's half-typed key.
  let keyInputs = $state<Record<string, string>>({});
  let saving = $state(false);
  let saveError = $state<string | null>(null);

  let searchInput: HTMLInputElement | undefined = $state();

  $effect(() => {
    searchInput?.focus();
  });

  // ESC closes the picker. Attached globally so focus doesn't need to be
  // on the picker itself — anywhere inside it works.
  $effect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const activeProviderEntry = $derived(
    activeProvider ? (catalog.find((e) => e.provider === activeProvider) ?? null) : null,
  );

  const locked = $derived(
    activeProviderEntry !== null && !activeProviderEntry.credentialConfigured,
  );

  // Flattened [provider, model] pairs filtered by active-provider pill
  // and search query. Recomputed whenever any of those change; the cost
  // is tiny (catalog is ~80 models) and keeps the render straightforward.
  const filtered = $derived.by(() => {
    if (locked) return [];
    const query = search.trim().toLowerCase();
    const rows: Array<{ entry: CatalogEntry; model: Model }> = [];
    for (const entry of catalog) {
      if (!entry.credentialConfigured) continue;
      if (activeProvider && entry.provider !== activeProvider) continue;
      for (const model of entry.models) {
        if (!query) {
          rows.push({ entry, model });
          continue;
        }
        const haystack = `${model.id} ${model.displayName} ${entry.meta.name}`.toLowerCase();
        if (haystack.includes(query)) rows.push({ entry, model });
      }
    }
    return rows;
  });

  const totalModelCount = $derived(
    catalog.reduce((n, e) => n + (e.credentialConfigured ? e.models.length : 0), 0),
  );

  // Split providers into API vs local-runtime groups for the pill row.
  // Right now "local runtime" is just claude-code (which shells out to
  // the `claude` CLI); more CLI-backed providers would be added to this
  // list rather than mixed in with API keys.
  const apiProviders = $derived(catalog.filter((e) => e.provider !== "claude-code"));
  const localProviders = $derived(catalog.filter((e) => e.provider === "claude-code"));

  function isSelected(provider: string, modelId: string): boolean {
    // `current.modelId` matches `model.id` directly — both are the raw
    // model identifier with no provider prefix (see ModelInfo in
    // packages/llm/src/model-catalog.ts).
    return current !== null && current.provider === provider && current.modelId === modelId;
  }

  async function handleSaveKey(entry: CatalogEntry): Promise<void> {
    const raw = keyInputs[entry.provider] ?? "";
    const value = raw.trim();
    if (!value || !entry.credentialEnvVar) return;
    saving = true;
    saveError = null;
    try {
      const updated = await saveApiKey(entry.credentialEnvVar, value);
      if (updated) {
        catalog = updated;
        // Clear the buffer for this provider — successful save means
        // the key is now in .env, no reason to keep it typed in memory.
        keyInputs = { ...keyInputs, [entry.provider]: "" };
      }
    } catch (err) {
      saveError = err instanceof Error ? err.message : String(err);
    } finally {
      saving = false;
    }
  }

  function handleKeyInputEnter(event: KeyboardEvent, entry: CatalogEntry): void {
    if (event.key === "Enter") void handleSaveKey(entry);
  }
</script>

<div
  class="picker-backdrop"
  role="presentation"
  onclick={(e) => {
    // Only close on explicit backdrop click, not on clicks that bubble
    // from inside the picker. Clicking the modal body should never
    // dismiss.
    if (e.target === e.currentTarget) onClose();
  }}
>
  <div class="picker" role="dialog" aria-modal="true" aria-label="Pick a model">
    <div class="picker-header">
      <div class="picker-title-row">
        <div>
          <h3 class="picker-title">Pick a model</h3>
          <div class="picker-context">
            {roleTitle.toLowerCase()} · {slotLabel}
          </div>
        </div>
        <button class="picker-close" onclick={onClose} aria-label="Close">✕</button>
      </div>
      <input
        bind:this={searchInput}
        class="picker-search"
        placeholder="Search models…"
        bind:value={search}
        spellcheck="false"
        autocomplete="off"
      />
    </div>

    <div class="provider-pills">
      <button
        class="provider-pill"
        class:active={activeProvider === null}
        onclick={() => { activeProvider = null; }}
      >
        <span>All</span>
        <span class="pill-count">{totalModelCount}</span>
      </button>
      {#each apiProviders as entry (entry.provider)}
        <button
          class="provider-pill"
          class:active={activeProvider === entry.provider}
          class:is-locked={!entry.credentialConfigured}
          onclick={() => { activeProvider = entry.provider; }}
          title={entry.credentialConfigured
            ? `${entry.meta.name} — connected`
            : `${entry.meta.name} — requires ${entry.credentialEnvVar}`}
        >
          <ProviderMark provider={entry.provider} letter={entry.meta.letter} size="sm" />
          <span>{entry.meta.name}</span>
          <span class="status-dot" class:locked={!entry.credentialConfigured}></span>
        </button>
      {/each}
      {#if localProviders.length > 0}
        <!-- Local-runtime providers (Claude Code) route through a CLI
             binary rather than a hosted API. Visually sectioned off so
             users don't read it as "yet another API provider". -->
        <span class="pills-divider" aria-hidden="true">│</span>
        <span class="pills-group-label">Local CLI</span>
        {#each localProviders as entry (entry.provider)}
          <button
            class="provider-pill"
            class:active={activeProvider === entry.provider}
            class:is-locked={!entry.credentialConfigured}
            onclick={() => { activeProvider = entry.provider; }}
            title={`${entry.meta.name} — routes through the local \`claude\` CLI`}
          >
            <ProviderMark provider={entry.provider} letter={entry.meta.letter} size="sm" />
            <span>{entry.meta.name}</span>
            <span class="status-dot" class:locked={!entry.credentialConfigured}></span>
          </button>
        {/each}
      {/if}
    </div>
    {#if activeProviderEntry?.provider === "claude-code"}
      <div class="provider-note">
        Claude Code runs locally via the <code>claude</code> CLI. Pick which
        Anthropic model the CLI should use for this slot.
      </div>
    {/if}

    {#if locked && activeProviderEntry}
      <div class="locked-banner">
        <div class="locked-banner-head">
          <ProviderMark
            provider={activeProviderEntry.provider}
            letter={activeProviderEntry.meta.letter}
          />
          <div class="locked-banner-title">
            Connect {activeProviderEntry.meta.name} first
          </div>
        </div>
        <div class="locked-banner-desc">
          {activeProviderEntry.meta.name}'s models are locked until we have an API key.
          Paste your key below — we'll save it to <code>~/.atlas/.env</code> as
          <code>{activeProviderEntry.credentialEnvVar}</code> and unlock
          {activeProviderEntry.meta.name} immediately.
          {#if activeProviderEntry.meta.helpUrl}
            Get a key from <code>{activeProviderEntry.meta.helpUrl}</code>.
          {/if}
        </div>
        <div class="key-input-row">
          <input
            type="password"
            placeholder={activeProviderEntry.meta.keyPrefix
              ? `${activeProviderEntry.meta.keyPrefix}…`
              : "API key"}
            value={keyInputs[activeProviderEntry.provider] ?? ""}
            oninput={(e) => {
              const v = (e.currentTarget as HTMLInputElement).value;
              keyInputs = { ...keyInputs, [activeProviderEntry.provider]: v };
            }}
            onkeydown={(e) => handleKeyInputEnter(e, activeProviderEntry)}
            autocomplete="off"
            spellcheck="false"
            disabled={saving}
          />
          <button
            class="btn primary"
            onclick={() => handleSaveKey(activeProviderEntry)}
            disabled={saving || !(keyInputs[activeProviderEntry.provider] ?? "").trim()}
          >
            {saving ? "Saving…" : "Save & unlock"}
          </button>
        </div>
        {#if saveError}
          <div class="picker-error">{saveError}</div>
        {/if}
      </div>
    {:else}
      <div class="picker-body">
        {#if allowDefault && activeProvider === null && search === ""}
          <button
            class="model-option default-option"
            class:selected={current === null}
            onclick={() => onSelect(null)}
          >
            <div class="default-spacer"></div>
            <div>
              <div class="model-title">Use default chain</div>
              <div class="model-sub">Fall back to the built-in resolution order</div>
            </div>
            {#if current === null}
              <span class="check">✓</span>
            {/if}
          </button>
        {/if}

        {#if filtered.length === 0}
          <div class="picker-empty">
            {search
              ? `No models match "${search}".`
              : "No credentialed providers. Pick a locked provider to add its API key."}
          </div>
        {:else if activeProvider === null}
          {#each catalog.filter((e) => e.credentialConfigured) as entry (entry.provider)}
            {@const rows = filtered.filter((r) => r.entry.provider === entry.provider)}
            {#if rows.length > 0}
              <div class="provider-section-header">
                {entry.meta.name}
                {#if entry.provider === "claude-code"}
                  <span class="provider-section-sub">routes via local <code>claude</code> CLI</span>
                {/if}
              </div>
              {#each rows as { entry: providerEntry, model } (model.id)}
                <button
                  class="model-option"
                  class:selected={isSelected(providerEntry.provider, model.id)}
                  onclick={() =>
                    onSelect({ provider: providerEntry.provider, modelId: model.id })}
                >
                  <ProviderMark
                    provider={providerEntry.provider}
                    letter={providerEntry.meta.letter}
                  />
                  <div class="model-body">
                    <div class="model-title">{model.displayName}</div>
                    <div class="model-sub">{providerEntry.provider}:{model.id}</div>
                  </div>
                  {#if isSelected(providerEntry.provider, model.id)}
                    <span class="check">✓</span>
                  {/if}
                </button>
              {/each}
            {/if}
          {/each}
        {:else}
          {#each filtered as { entry, model } (model.id)}
            <button
              class="model-option"
              class:selected={isSelected(entry.provider, model.id)}
              onclick={() => onSelect({ provider: entry.provider, modelId: model.id })}
            >
              <ProviderMark provider={entry.provider} letter={entry.meta.letter} />
              <div class="model-body">
                <div class="model-title">{model.displayName}</div>
                <div class="model-sub">{entry.provider}:{model.id}</div>
              </div>
              {#if isSelected(entry.provider, model.id)}
                <span class="check">✓</span>
              {/if}
            </button>
          {/each}
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .picker-backdrop {
    background: hsl(220 8% 2% / 0.55);
    backdrop-filter: blur(2px);
    display: grid;
    inset: 0;
    place-items: center;
    position: fixed;
    z-index: 50;
    animation: fadein 140ms ease;
  }
  @keyframes fadein {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  @keyframes slidein {
    from { opacity: 0; transform: translateY(6px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .picker {
    animation: slidein 180ms cubic-bezier(0.2, 0.9, 0.2, 1);
    background: var(--color-surface-2, hsl(220 8% 9%));
    border: 1px solid var(--color-border-2, hsl(220 6% 24%));
    border-radius: 10px;
    box-shadow: 0 20px 60px hsl(220 8% 0% / 0.6);
    display: flex;
    flex-direction: column;
    max-height: min(640px, calc(100vh - 80px));
    overflow: hidden;
    width: min(640px, calc(100vw - 48px));
  }

  .picker-header {
    border-bottom: 1px solid var(--color-border-1, hsl(220 6% 18%));
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 16px 20px;
  }
  .picker-title-row {
    align-items: baseline;
    display: flex;
    gap: 12px;
    justify-content: space-between;
  }
  .picker-title {
    font-size: 17px;
    font-weight: 600;
    margin: 0;
  }
  .picker-context {
    color: var(--color-text-faint, hsl(40 6% 48%));
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 12px;
  }
  .picker-close {
    background: transparent;
    border: none;
    border-radius: 4px;
    color: var(--color-text-faint, hsl(40 6% 48%));
    cursor: pointer;
    font-size: 18px;
    line-height: 1;
    padding: 4px 8px;
  }
  .picker-close:hover {
    background: var(--color-surface-3, hsl(220 8% 13%));
    color: var(--color-text, hsl(40 12% 95%));
  }

  .picker-search {
    background: var(--color-surface-1, hsl(220 8% 6%));
    border: 1px solid var(--color-border-1, hsl(220 6% 18%));
    border-radius: 6px;
    color: var(--color-text, hsl(40 12% 95%));
    font-family: inherit;
    font-size: 13px;
    outline: none;
    padding: 8px 12px;
    width: 100%;
  }
  .picker-search:focus {
    border-color: var(--color-primary, hsl(212 97% 58%));
  }

  .provider-pills {
    border-bottom: 1px solid var(--color-border-1, hsl(220 6% 18%));
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 12px 20px;
  }
  .provider-pill {
    align-items: center;
    background: var(--color-surface-3, hsl(220 8% 13%));
    border: 1px solid transparent;
    border-radius: 999px;
    color: var(--color-text-dim, hsl(40 8% 68%));
    cursor: pointer;
    display: inline-flex;
    font-family: inherit;
    font-size: 13px;
    font-weight: 500;
    gap: 8px;
    padding: 5px 12px 5px 8px;
    transition: all 120ms ease;
  }
  .provider-pill:hover {
    background: var(--color-surface-4, hsl(220 8% 17%));
    color: var(--color-text, hsl(40 12% 95%));
  }
  .provider-pill.active {
    background: var(--color-surface-5, hsl(220 8% 22%));
    border-color: var(--color-border-2, hsl(220 6% 24%));
    color: var(--color-text, hsl(40 12% 95%));
  }
  .provider-pill.is-locked {
    color: var(--color-text-faint, hsl(40 6% 48%));
  }
  .pill-count {
    color: var(--color-text-faint, hsl(40 6% 48%));
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 12px;
    margin-left: 2px;
  }

  .pills-divider {
    color: var(--color-border-2, hsl(220 6% 24%));
    font-size: 16px;
    padding: 0 2px;
    user-select: none;
  }

  .pills-group-label {
    color: var(--color-text-faint, hsl(40 6% 48%));
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 11px;
    letter-spacing: 0.08em;
    padding: 5px 2px;
    text-transform: uppercase;
  }

  .provider-note {
    background: color-mix(in srgb, var(--color-primary, hsl(212 97% 58%)), transparent 92%);
    border-bottom: 1px solid var(--color-border-1, hsl(220 6% 18%));
    color: var(--color-text-dim, hsl(40 8% 68%));
    font-size: 12px;
    line-height: 1.5;
    padding: 10px 20px;
  }
  .provider-note code {
    background: var(--color-surface-4, hsl(220 8% 17%));
    border-radius: 3px;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 0.92em;
    padding: 1px 5px;
  }

  .provider-section-sub {
    color: var(--color-text-faint, hsl(40 6% 48%));
    font-family: var(--font-sans, ui-sans-serif, system-ui);
    font-size: 11px;
    font-weight: 500;
    letter-spacing: normal;
    margin-left: 8px;
    text-transform: none;
  }
  .provider-section-sub code {
    background: var(--color-surface-4, hsl(220 8% 17%));
    border-radius: 2px;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 0.95em;
    padding: 0 4px;
  }

  .status-dot {
    background: hsl(142 70% 55%);
    border-radius: 50%;
    flex-shrink: 0;
    height: 6px;
    margin-left: 2px;
    width: 6px;
  }
  .status-dot.locked {
    background: hsl(40 6% 55%);
  }

  .picker-body {
    flex: 1;
    overflow-y: auto;
    padding: 12px 8px;
  }

  .picker-empty {
    color: var(--color-text-faint, hsl(40 6% 48%));
    font-size: 13px;
    padding: 40px 20px;
    text-align: center;
  }

  .model-option {
    align-items: center;
    background: transparent;
    border: none;
    border-radius: 6px;
    color: inherit;
    cursor: pointer;
    display: grid;
    font-family: inherit;
    gap: 12px;
    grid-template-columns: 28px 1fr auto;
    padding: 10px 12px;
    text-align: left;
    transition: background 100ms ease;
    width: 100%;
  }
  .model-option:hover {
    background: var(--color-surface-3, hsl(220 8% 13%));
  }
  .model-option.selected {
    background: hsl(212 97% 58% / 0.12);
  }
  .model-body {
    min-width: 0;
  }
  .model-title {
    color: var(--color-text, hsl(40 12% 95%));
    font-size: 14px;
    font-weight: 500;
  }
  .model-sub {
    color: var(--color-text-faint, hsl(40 6% 48%));
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 12px;
    margin-top: 2px;
  }
  .check {
    color: var(--color-primary, hsl(212 97% 58%));
    font-size: 14px;
  }

  .default-option {
    border-bottom: 1px solid var(--color-border-1, hsl(220 6% 18%));
    margin-bottom: 8px;
    padding-bottom: 12px;
  }
  .default-spacer {
    width: 28px;
  }

  .provider-section-header {
    color: var(--color-text-faint, hsl(40 6% 48%));
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.08em;
    padding: 12px 12px 4px;
    text-transform: uppercase;
  }

  .locked-banner {
    background: var(--color-surface-3, hsl(220 8% 13%));
    border: 1px solid var(--color-border-2, hsl(220 6% 24%));
    border-radius: 6px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin: 12px;
    padding: 16px;
  }
  .locked-banner-head {
    align-items: center;
    display: flex;
    gap: 10px;
  }
  .locked-banner-title {
    font-size: 14px;
    font-weight: 600;
  }
  .locked-banner-desc {
    color: var(--color-text-dim, hsl(40 8% 68%));
    font-size: 13px;
    line-height: 1.5;
  }
  .locked-banner-desc code {
    background: var(--color-surface-4, hsl(220 8% 17%));
    border-radius: 3px;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 0.92em;
    padding: 1px 6px;
  }

  .key-input-row {
    align-items: stretch;
    display: flex;
    gap: 8px;
  }
  .key-input-row input {
    background: var(--color-surface-1, hsl(220 8% 6%));
    border: 1px solid var(--color-border-2, hsl(220 6% 24%));
    border-radius: 6px;
    color: var(--color-text, hsl(40 12% 95%));
    flex: 1;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 13px;
    outline: none;
    padding: 8px 12px;
  }
  .key-input-row input:focus {
    border-color: var(--color-primary, hsl(212 97% 58%));
  }

  .picker-error {
    color: hsl(4 86% 66%);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 12px;
  }

  .btn {
    background: var(--color-surface-4, hsl(220 8% 17%));
    border: 1px solid var(--color-border-2, hsl(220 6% 24%));
    border-radius: 6px;
    color: var(--color-text, hsl(40 12% 95%));
    cursor: pointer;
    font-family: inherit;
    font-size: 13px;
    font-weight: 500;
    padding: 8px 14px;
    transition: all 120ms ease;
    white-space: nowrap;
  }
  .btn:hover:not(:disabled) {
    background: var(--color-surface-5, hsl(220 8% 22%));
  }
  .btn:disabled {
    cursor: not-allowed;
    opacity: 0.4;
  }
  .btn.primary {
    background: var(--color-primary, hsl(212 97% 58%));
    border-color: var(--color-primary, hsl(212 97% 58%));
    color: hsl(220 8% 6%);
    font-weight: 600;
  }
  .btn.primary:hover:not(:disabled) {
    background: hsl(212 97% 65%);
    border-color: hsl(212 97% 65%);
  }
</style>
