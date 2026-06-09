<!--
  Image-role model picker — opens when the user clicks an image-chain slot.

  Differs from the language `<ModelPicker>` in three ways:
    1. Options come from the static capability overlay
       (`listImageEntries()` from @atlas/llm) — not from `catalog.models`.
       The overlay is the source of truth for "what can this model do."
       Gateway-only ids (no overlay entry) are never shown; overlay
       entries the gateway doesn't currently surface are still shown.
    2. Each option renders capability badges (`gen ✓` always; `edit ✓` or
       `edit ✗` per entry) and the optional `note` (e.g. "requires
       verified OpenAI org").
    3. No search + no provider-pill filter — the overlay is ~6 entries,
       both are noise. Provider grouping is rendered inline.

  Locked-banner UX reuses the same inline "Save & unlock" flow the
  language picker provides via `saveApiKey`. When a provider is locked,
  its overlay entries are hidden behind the banner — picking is gated on
  credential presence.

  @component
-->
<script lang="ts">
  import { listImageEntries } from "@atlas/llm/image-capabilities";
  import { getHotkeyRegistry } from "@atlas/ui";
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
    images: Model[];
    error?: string;
  }
  interface ModelChoice {
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
    saveApiKey: (envVar: string, value: string) => Promise<CatalogEntry[]>;
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

  // Mutate the local copy when an inline "Save & unlock" succeeds so the
  // banner flips to the unlocked entry list immediately. Parent gets the
  // refreshed catalog through `saveApiKey`'s return value.
  let catalog = $state(initialCatalog);

  // Per-provider inline key buffer — switching providers while typing
  // shouldn't wipe an in-flight key.
  let keyInputs = $state<Record<string, string>>({});
  let saving = $state(false);
  let saveError = $state<string | null>(null);

  // Escape closes the picker. Stack-registered so focus can be anywhere
  // on the page.
  const hotkeys = getHotkeyRegistry();
  $effect(() =>
    hotkeys.register({
      key: "Escape",
      handler: () => onClose(),
    }),
  );

  interface ImageOption {
    /** Full `provider:modelId` overlay key. */
    id: string;
    provider: string;
    modelId: string;
    displayName: string;
    capabilities: { generation: true; edit: boolean };
    note?: string;
  }

  /**
   * Group all overlay entries by provider so the picker can render them
   * under per-provider section headers (or behind a locked-banner if the
   * provider's credentials are missing). Overlay membership is the gate;
   * gateway listing is a freshness signal only — entries the gateway
   * doesn't surface are still shown.
   */
  const optionsByProvider = $derived.by<Map<string, ImageOption[]>>(() => {
    const out = new Map<string, ImageOption[]>();
    for (const entry of listImageEntries()) {
      const idx = entry.id.indexOf(":");
      if (idx <= 0) continue;
      const provider = entry.id.slice(0, idx);
      const modelId = entry.id.slice(idx + 1);
      const option: ImageOption = {
        id: entry.id,
        provider,
        modelId,
        displayName: entry.displayName,
        capabilities: entry.capabilities,
        ...(entry.note !== undefined ? { note: entry.note } : {}),
      };
      const list = out.get(provider) ?? [];
      list.push(option);
      out.set(provider, list);
    }
    return out;
  });

  /**
   * Resolve a per-provider catalog entry so we can render the provider
   * mark (letter glyph) and consult `credentialConfigured` for the
   * locked-banner gate. Falls back to a synthetic entry when the catalog
   * fetch failed entirely — overlay entries should still render in that
   * case so the user can pick something and see the credential warning
   * elsewhere.
   */
  function lookupProvider(provider: string): CatalogEntry | null {
    return catalog.find((e) => e.provider === provider) ?? null;
  }

  function isSelected(provider: string, modelId: string): boolean {
    return current !== null && current.provider === provider && current.modelId === modelId;
  }

  async function handleSaveKey(entry: CatalogEntry): Promise<void> {
    const raw = keyInputs[entry.provider] ?? "";
    const value = raw.trim();
    if (!value || !entry.credentialEnvVar) return;
    saving = true;
    saveError = null;
    try {
      catalog = await saveApiKey(entry.credentialEnvVar, value);
      keyInputs = { ...keyInputs, [entry.provider]: "" };
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
    if (e.target === e.currentTarget) onClose();
  }}
>
  <div class="picker" role="dialog" aria-modal="true" aria-label="Pick an image model">
    <div class="picker-header">
      <div class="picker-title-row">
        <div>
          <h3 class="picker-title">Pick an image model</h3>
          <div class="picker-context">
            {roleTitle.toLowerCase()} · {slotLabel}
          </div>
        </div>
        <button class="picker-close" onclick={onClose} aria-label="Close">✕</button>
      </div>
      <p class="picker-help">
        Verified image models only. Each option lists which operations it supports — generation
        (<code>gen</code>) is universal; edit support varies. Defaults (size / aspect ratio /
        format) are baked into the overlay.
      </p>
    </div>

    <div class="picker-body">
      {#if allowDefault}
        <button
          class="model-option default-option"
          class:selected={current === null}
          onclick={() => onSelect(null)}
        >
          <div class="default-spacer"></div>
          <div class="model-body">
            <div class="model-title">Use default chain</div>
            <div class="model-sub">Fall back to the built-in image-model resolution order</div>
          </div>
          {#if current === null}
            <span class="check">✓</span>
          {/if}
        </button>
      {/if}

      {#each [...optionsByProvider] as [providerKey, options] (providerKey)}
        {@const providerEntry = lookupProvider(providerKey)}
        {@const providerName = providerEntry?.meta.name ?? providerKey}
        {@const providerLetter =
          providerEntry?.meta.letter ?? providerKey.charAt(0).toUpperCase()}
        {@const locked = providerEntry !== null && !providerEntry.credentialConfigured}

        <div class="provider-section-header">
          <ProviderMark provider={providerKey} letter={providerLetter} size="sm" />
          <span>{providerName}</span>
          {#if locked}
            <span class="locked-tag">locked</span>
          {/if}
        </div>

        {#if locked && providerEntry}
          <div class="locked-banner">
            <div class="locked-banner-desc">
              {providerName}'s image models are locked until we have an API key. Paste your key
              below — we'll save it to the daemon's .env file as
              <code>{providerEntry.credentialEnvVar}</code>
              and unlock {providerName} immediately.
              {#if providerEntry.meta.helpUrl}
                Get a key from <code>{providerEntry.meta.helpUrl}</code>.
              {/if}
            </div>
            <div class="key-input-row">
              <input
                type="password"
                placeholder={providerEntry.meta.keyPrefix
                  ? `${providerEntry.meta.keyPrefix}…`
                  : "API key"}
                value={keyInputs[providerEntry.provider] ?? ""}
                oninput={(e) => {
                  const v = (e.currentTarget as HTMLInputElement).value;
                  keyInputs = { ...keyInputs, [providerEntry.provider]: v };
                }}
                onkeydown={(e) => handleKeyInputEnter(e, providerEntry)}
                autocomplete="off"
                spellcheck="false"
                disabled={saving}
              />
              <button
                class="btn primary"
                onclick={() => handleSaveKey(providerEntry)}
                disabled={saving || !(keyInputs[providerEntry.provider] ?? "").trim()}
              >
                {saving ? "Saving…" : "Save & unlock"}
              </button>
            </div>
            {#if saveError}
              <div class="picker-error">{saveError}</div>
            {/if}
          </div>
        {:else}
          {#each options as option (option.id)}
            <button
              class="model-option"
              class:selected={isSelected(option.provider, option.modelId)}
              onclick={() => onSelect({ provider: option.provider, modelId: option.modelId })}
            >
              <ProviderMark provider={option.provider} letter={providerLetter} />
              <div class="model-body">
                <div class="model-title">{option.displayName}</div>
                <div class="model-sub">{option.id}</div>
                {#if option.note}
                  <div class="model-note">{option.note}</div>
                {/if}
              </div>
              <div class="badges">
                <span class="badge yes" title="Supports image generation">gen ✓</span>
                <span
                  class="badge"
                  class:yes={option.capabilities.edit}
                  class:no={!option.capabilities.edit}
                  title={option.capabilities.edit
                    ? "Supports image editing"
                    : "Generation only — cannot edit existing images"}
                >
                  edit {option.capabilities.edit ? "✓" : "✗"}
                </span>
              </div>
              {#if isSelected(option.provider, option.modelId)}
                <span class="check">✓</span>
              {/if}
            </button>
          {/each}
        {/if}
      {/each}
    </div>
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
    background: var(--color-surface-2);
    border: 1px solid var(--color-border-2);
    border-radius: 10px;
    box-shadow: 0 20px 60px hsl(220 8% 0% / 0.6);
    display: flex;
    flex-direction: column;
    max-height: min(640px, calc(100vh - 80px));
    overflow: hidden;
    width: min(640px, calc(100vw - 48px));
  }

  .picker-header {
    border-bottom: 1px solid var(--color-border-1);
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
    color: color-mix(in srgb, var(--color-text), transparent 55%);
    font-family: var(--font-family-monospace);
    font-size: 12px;
  }
  .picker-close {
    background: transparent;
    border: none;
    border-radius: 4px;
    color: color-mix(in srgb, var(--color-text), transparent 55%);
    cursor: pointer;
    font-size: 18px;
    line-height: 1;
    padding: 4px 8px;
  }
  .picker-close:hover {
    background: var(--color-surface-3);
    color: var(--color-text);
  }
  .picker-help {
    color: color-mix(in srgb, var(--color-text), transparent 35%);
    font-size: 12px;
    line-height: 1.5;
    margin: 0;
  }
  .picker-help code {
    background: var(--color-surface-3);
    border-radius: 3px;
    font-family: var(--font-family-monospace);
    font-size: 0.92em;
    padding: 1px 5px;
  }

  .picker-body {
    flex: 1;
    overflow-y: auto;
    padding: 8px 8px 12px;
  }

  .provider-section-header {
    align-items: center;
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    display: flex;
    font-size: 13px;
    font-weight: 600;
    gap: 8px;
    letter-spacing: 0.02em;
    padding: 14px 12px 6px;
  }
  .locked-tag {
    background: color-mix(in srgb, var(--color-warning), transparent 80%);
    border-radius: 999px;
    color: var(--color-warning);
    font-family: var(--font-family-monospace);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.06em;
    margin-left: auto;
    padding: 2px 8px;
    text-transform: uppercase;
  }

  .model-option {
    align-items: start;
    background: transparent;
    border: none;
    border-radius: 6px;
    color: inherit;
    cursor: pointer;
    display: grid;
    font-family: inherit;
    gap: 12px;
    grid-template-columns: 28px 1fr auto auto;
    padding: 10px 12px;
    text-align: left;
    transition: background 100ms ease;
    width: 100%;
  }
  .model-option:hover {
    background: var(--color-surface-3);
  }
  .model-option.selected {
    background: color-mix(in srgb, var(--color-accent), transparent 88%);
  }
  .model-body {
    min-width: 0;
  }
  .model-title {
    color: var(--color-text);
    font-size: 14px;
    font-weight: 500;
  }
  .model-sub {
    color: color-mix(in srgb, var(--color-text), transparent 55%);
    font-family: var(--font-family-monospace);
    font-size: 12px;
    margin-top: 2px;
  }
  .model-note {
    color: color-mix(in srgb, var(--color-text), transparent 35%);
    font-size: 12px;
    font-style: italic;
    line-height: 1.4;
    margin-top: 4px;
  }
  .check {
    color: var(--color-accent);
    font-size: 14px;
  }

  .badges {
    align-items: center;
    display: flex;
    flex-shrink: 0;
    gap: 6px;
  }
  .badge {
    border-radius: 4px;
    font-family: var(--font-family-monospace);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
    padding: 2px 6px;
    white-space: nowrap;
  }
  .badge.yes {
    background: color-mix(in srgb, var(--color-success), transparent 82%);
    color: var(--color-success);
  }
  .badge.no {
    background: color-mix(in srgb, var(--color-text), transparent 88%);
    color: color-mix(in srgb, var(--color-text), transparent 45%);
  }

  .default-option {
    border-bottom: 1px solid var(--color-border-1);
    display: grid;
    grid-template-columns: 28px 1fr auto;
    margin-bottom: 4px;
    padding-bottom: 12px;
  }
  .default-spacer {
    width: 28px;
  }

  .locked-banner {
    background: var(--color-surface-3);
    border: 1px solid var(--color-border-2);
    border-radius: 6px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin: 4px 12px 8px;
    padding: 14px;
  }
  .locked-banner-desc {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-size: 13px;
    line-height: 1.5;
  }
  .locked-banner-desc code {
    background: color-mix(in srgb, var(--color-text), transparent 88%);
    border-radius: 3px;
    font-family: var(--font-family-monospace);
    font-size: 0.92em;
    padding: 1px 6px;
  }

  .key-input-row {
    align-items: stretch;
    display: flex;
    gap: 8px;
  }
  .key-input-row input {
    background: var(--color-surface-1);
    border: 1px solid var(--color-border-2);
    border-radius: 6px;
    color: var(--color-text);
    flex: 1;
    font-family: var(--font-family-monospace);
    font-size: 13px;
    outline: none;
    padding: 8px 12px;
  }
  .key-input-row input:focus {
    border-color: var(--color-accent);
  }

  .picker-error {
    color: var(--color-error);
    font-family: var(--font-family-monospace);
    font-size: 12px;
  }

  .btn {
    background: var(--color-surface-3);
    border: 1px solid var(--color-border-2);
    border-radius: 6px;
    color: var(--color-text);
    cursor: pointer;
    font-family: inherit;
    font-size: 13px;
    font-weight: 500;
    padding: 8px 14px;
    transition: all 120ms ease;
    white-space: nowrap;
  }
  .btn:hover:not(:disabled) {
    background: color-mix(in srgb, var(--color-text), transparent 88%);
  }
  .btn:disabled {
    cursor: not-allowed;
    opacity: 0.4;
  }
  .btn.primary {
    background: var(--color-accent);
    border-color: var(--color-accent);
    color: hsl(220 8% 6%);
    font-weight: 600;
  }
  .btn.primary:hover:not(:disabled) {
    filter: brightness(1.1);
  }
</style>
