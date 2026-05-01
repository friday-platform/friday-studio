<!--
  Per-role chain display — primary + optional fallback slots.

  Three states:
  1. Chain empty → render the daemon's resolved default as a read-only
     tile with an "Override" button. Clicking Override opens the picker
     so the user can set a concrete primary.
  2. Chain has one entry → primary only. No fallbacks yet. Show an
     "Add fallback" button below.
  3. Chain has 2+ entries → primary + fallback rows. Each fallback is
     draggable (HTML5 drag-and-drop) and removable. If any fallback id
     matches primary id, a duplicate warning pill appears below the
     chain ("duplicates provide no failover benefit").

  Max chain length is {@link MAX_CHAIN}. Slot 0 is always primary.
-->
<script lang="ts">
  import ProviderMark from "./provider-mark.svelte";

  interface ModelChoice {
    provider: string;
    modelId: string;
  }
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

  interface Props {
    role: string;
    /** The user-configured chain. Empty array = "use default". */
    chain: ModelChoice[];
    /** Whatever the daemon resolved for this role at startup. Rendered
     * when `chain` is empty so the user sees what's actually in use. */
    resolved: ModelChoice;
    catalog: CatalogEntry[];
    onEditSlot: (slotIdx: number) => void;
    onRemoveSlot: (slotIdx: number) => void;
    onReorder: (from: number, to: number) => void;
    onAddFallback: () => void;
    onOverrideDefault: () => void;
  }

  const {
    role,
    chain,
    resolved,
    catalog,
    onEditSlot,
    onRemoveSlot,
    onReorder,
    onAddFallback,
    onOverrideDefault,
  }: Props = $props();

  const MAX_CHAIN = 4;
  const SLOT_LABELS = ["PRIMARY", "FALLBACK 1", "FALLBACK 2", "FALLBACK 3"];

  let dragIdx = $state<number | null>(null);
  let hoverIdx = $state<number | null>(null);

  const usingDefaults = $derived(chain.length === 0);
  const displayChain = $derived(usingDefaults ? [resolved] : chain);
  // "Add fallback" is always reachable, including from the default state
  // where the visible primary is the daemon-resolved default. The parent's
  // onAddFallback handler knows how to promote that resolved entry into
  // an explicit chain when the first fallback is added. Cap at MAX_CHAIN
  // either way.
  const effectiveChainLength = $derived(usingDefaults ? 1 : chain.length);
  const canAddFallback = $derived(effectiveChainLength < MAX_CHAIN);

  // Duplicate detection: any non-primary slot whose choice matches the
  // primary's provider:model is flagged. Duplicates are legal (friday.yml
  // accepts them) but useless — they don't provide failover.
  const warnIndices = $derived.by(() => {
    if (displayChain.length < 2) return new Set<number>();
    const primary = displayChain[0];
    if (!primary) return new Set<number>();
    const primaryKey = `${primary.provider}:${primary.modelId}`;
    const out = new Set<number>();
    displayChain.forEach((c, i) => {
      if (i === 0) return;
      if (`${c.provider}:${c.modelId}` === primaryKey) out.add(i);
    });
    return out;
  });

  // Look up catalog metadata for a choice so the tile can render the
  // provider letter glyph and the human-readable display name. Unknown
  // provider or model (e.g. user-typed custom id the catalog doesn't know
  // about yet) falls back to the raw provider/id — no broken rendering.
  function lookup(choice: ModelChoice): {
    entry: CatalogEntry | undefined;
    displayName: string;
    locked: boolean;
  } {
    const entry = catalog.find((e) => e.provider === choice.provider);
    const model = entry?.models.find((m) => m.id === choice.modelId);
    return {
      entry,
      displayName: model?.displayName ?? choice.modelId,
      locked: entry !== undefined && !entry.credentialConfigured,
    };
  }

  function handleDragStart(i: number) {
    return (e: DragEvent) => {
      dragIdx = i;
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        try {
          e.dataTransfer.setData("text/plain", String(i));
        } catch {
          /* older browsers; ignored */
        }
      }
    };
  }
  function handleDragOver(i: number) {
    return (e: DragEvent) => {
      e.preventDefault();
      hoverIdx = i;
    };
  }
  function handleDrop(i: number) {
    return (e: DragEvent) => {
      e.preventDefault();
      if (dragIdx !== null && dragIdx !== i) onReorder(dragIdx, i);
      dragIdx = null;
      hoverIdx = null;
    };
  }
  function handleDragEnd(): void {
    dragIdx = null;
    hoverIdx = null;
  }
</script>

<div class="role-chain" data-role={role}>
  {#each displayChain as choice, i (i + ":" + choice.provider + ":" + choice.modelId)}
    {@const isPrimary = i === 0}
    {@const { entry, displayName, locked } = lookup(choice)}
    <div
      class="chain-item"
      class:is-primary={isPrimary}
      class:is-default={usingDefaults}
      class:is-dragging={dragIdx === i}
      class:is-drop-target={hoverIdx === i && dragIdx !== null && dragIdx !== i}
      class:warn={warnIndices.has(i)}
      draggable={!usingDefaults && chain.length > 1}
      ondragstart={handleDragStart(i)}
      ondragover={handleDragOver(i)}
      ondrop={handleDrop(i)}
      ondragend={handleDragEnd}
    >
      <span class="chain-slot" class:is-primary={isPrimary}>
        {SLOT_LABELS[i] ?? `FALLBACK ${i}`}
      </span>
      <span class="chain-drag" aria-hidden="true" title="Drag to reorder">⋮⋮</span>
      <button
        class="model-tile"
        type="button"
        onclick={() => (usingDefaults ? onOverrideDefault() : onEditSlot(i))}
      >
        {#if entry}
          <ProviderMark provider={entry.provider} letter={entry.meta.letter} />
        {:else}
          <ProviderMark
            provider={choice.provider}
            letter={choice.provider.charAt(0).toUpperCase()}
          />
        {/if}
        <div class="model-info">
          <span class="model-name">{displayName}</span>
          <span class="model-provider">{choice.provider}</span>
        </div>
        <span class="status-dot" class:locked></span>
        {#if usingDefaults}
          <span class="default-pill">DEFAULT</span>
        {/if}
      </button>
      <div class="chain-actions">
        {#if usingDefaults && isPrimary}
          <button
            class="chain-btn override"
            type="button"
            onclick={onOverrideDefault}
            title="Replace the default with your own chain"
          >
            Override
          </button>
        {:else if !isPrimary}
          <button
            class="chain-btn"
            type="button"
            onclick={() => onRemoveSlot(i)}
            title="Remove this fallback"
            aria-label="Remove fallback"
          >
            ✕
          </button>
        {/if}
      </div>
    </div>
  {/each}

  {#if warnIndices.size > 0}
    <div class="warn-pill">Fallback matches primary — duplicates provide no failover benefit.</div>
  {/if}

  {#if canAddFallback}
    <button class="add-fallback" type="button" onclick={onAddFallback}>
      <span class="plus">＋</span>
      Add fallback (slot {effectiveChainLength + 1})
    </button>
  {/if}
</div>

<style>
  /*
   * Atlas exposes surface-1/2/3 + text + border-1/2 + accent + success/warning
   * via light-dark(). The original styles reached for surface-4 / text-faint /
   * text-dim / border-strong / font-mono / color-primary — none of those
   * tokens exist in packages/ui/src/lib/tokens.css. CSS custom-property
   * fallbacks kicked in with hardcoded dark values, which meant this
   * component rendered "dark" regardless of `prefers-color-scheme`.
   *
   * Replacements:
   *   surface-4        → color-mix on the emphasized background (one step
   *                      above surface-3 in both modes)
   *   text-faint / dim → color-mix on --color-text with transparency — same
   *                      pattern other playground pages use
   *   border-strong    → --color-border-2 (darker edge in both modes)
   *   color-primary    → --color-accent
   *   font-mono        → --font-family-monospace
   */

  .role-chain {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }

  .chain-item {
    align-items: center;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: 6px;
    display: grid;
    gap: 8px;
    grid-template-columns: 64px 16px 1fr auto;
    min-height: 44px;
    padding: 8px 10px;
    transition:
      background 120ms ease,
      border-color 120ms ease;
  }
  .chain-item.is-primary {
    background: var(--color-surface-3);
    border-color: var(--color-border-2);
  }
  .chain-item.is-dragging {
    opacity: 0.4;
  }
  .chain-item.is-drop-target {
    border-color: var(--color-accent);
    box-shadow: inset 0 0 0 1px var(--color-accent);
  }
  .chain-item.warn {
    border-color: color-mix(in srgb, var(--color-warning), transparent 55%);
  }

  .chain-slot {
    color: color-mix(in srgb, var(--color-text), transparent 55%);
    font-family: var(--font-family-monospace);
    font-size: 12px;
    letter-spacing: 0.04em;
    text-align: center;
  }
  .chain-slot.is-primary {
    color: var(--color-text);
    font-weight: 600;
  }

  .chain-drag {
    color: color-mix(in srgb, var(--color-text), transparent 55%);
    cursor: grab;
    font-size: 14px;
    line-height: 1;
    opacity: 0.5;
    text-align: center;
    transition: opacity 120ms ease;
    user-select: none;
  }
  .chain-item:hover .chain-drag {
    opacity: 0.9;
  }
  .chain-drag:active {
    cursor: grabbing;
  }
  .chain-item.is-default .chain-drag {
    visibility: hidden;
  }

  .model-tile {
    align-items: center;
    background: transparent;
    border: none;
    border-radius: 4px;
    color: inherit;
    cursor: pointer;
    display: flex;
    flex: 1;
    font-family: inherit;
    gap: 10px;
    min-width: 0;
    padding: 0;
    text-align: left;
  }
  .model-tile:hover .model-name {
    color: var(--color-text);
  }
  .chain-item.is-default .model-name {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
  }

  .model-info {
    display: flex;
    flex-direction: column;
    line-height: 1.25;
    min-width: 0;
  }
  .model-name {
    color: var(--color-text);
    font-family: var(--font-family-monospace);
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .model-provider {
    color: color-mix(in srgb, var(--color-text), transparent 55%);
    font-family: var(--font-family-monospace);
    font-size: 12px;
    letter-spacing: 0.02em;
  }

  .status-dot {
    background: var(--color-success);
    border-radius: 50%;
    flex-shrink: 0;
    height: 6px;
    width: 6px;
  }
  .status-dot.locked {
    background: color-mix(in srgb, var(--color-text), transparent 55%);
  }

  .default-pill {
    border: 1px solid var(--color-border-2);
    border-radius: 999px;
    color: color-mix(in srgb, var(--color-text), transparent 55%);
    font-family: var(--font-family-monospace);
    font-size: 10px;
    letter-spacing: 0.1em;
    padding: 1px 8px;
    text-transform: uppercase;
  }

  .chain-actions {
    align-items: center;
    display: flex;
    gap: 2px;
  }

  .chain-btn {
    background: transparent;
    border: none;
    border-radius: 4px;
    color: color-mix(in srgb, var(--color-text), transparent 55%);
    cursor: pointer;
    font-family: inherit;
    font-size: 12px;
    padding: 4px 6px;
    transition:
      background 120ms ease,
      color 120ms ease;
  }
  .chain-btn:hover {
    background: var(--color-surface-3);
    color: var(--color-text);
  }
  .chain-btn.override {
    padding: 4px 10px;
  }

  .add-fallback {
    align-items: center;
    background: transparent;
    border: 1px dashed var(--color-border-2);
    border-radius: 6px;
    color: color-mix(in srgb, var(--color-text), transparent 55%);
    cursor: pointer;
    display: flex;
    font-family: inherit;
    font-size: 13px;
    gap: 8px;
    padding: 8px 12px;
    text-align: left;
    transition:
      border-color 120ms,
      color 120ms;
  }
  .add-fallback:hover {
    border-color: color-mix(in srgb, var(--color-text), transparent 60%);
    color: color-mix(in srgb, var(--color-text), transparent 30%);
  }
  .plus {
    font-size: 16px;
    line-height: 1;
  }

  .warn-pill {
    align-items: center;
    color: var(--color-warning);
    display: inline-flex;
    font-family: var(--font-family-monospace);
    font-size: 12px;
    gap: 6px;
    margin-top: 2px;
  }
  .warn-pill::before {
    background: var(--color-warning);
    border-radius: 50%;
    content: "";
    height: 6px;
    width: 6px;
  }
</style>
