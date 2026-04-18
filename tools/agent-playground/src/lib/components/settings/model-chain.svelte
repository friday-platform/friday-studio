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
          <ProviderMark provider={choice.provider} letter={choice.provider.charAt(0).toUpperCase()} />
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
    <div class="warn-pill">
      Fallback matches primary — duplicates provide no failover benefit.
    </div>
  {/if}

  {#if canAddFallback}
    <button class="add-fallback" type="button" onclick={onAddFallback}>
      <span class="plus">＋</span>
      Add fallback (slot {effectiveChainLength + 1})
    </button>
  {/if}
</div>

<style>
  .role-chain {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }

  .chain-item {
    align-items: center;
    background: var(--color-surface-3, hsl(220 8% 13%));
    border: 1px solid var(--color-border-1, hsl(220 6% 18%));
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
    background: var(--color-surface-4, hsl(220 8% 17%));
    border-color: var(--color-border-2, hsl(220 6% 24%));
  }
  .chain-item.is-dragging {
    opacity: 0.4;
  }
  .chain-item.is-drop-target {
    border-color: var(--color-primary, hsl(212 97% 58%));
    box-shadow: inset 0 0 0 1px var(--color-primary, hsl(212 97% 58%));
  }
  .chain-item.warn {
    border-color: color-mix(in srgb, hsl(38 92% 60%), transparent 55%);
  }

  .chain-slot {
    color: var(--color-text-faint, hsl(40 6% 48%));
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 12px;
    letter-spacing: 0.04em;
    text-align: center;
  }
  .chain-slot.is-primary {
    color: var(--color-text, hsl(40 12% 95%));
    font-weight: 600;
  }

  .chain-drag {
    color: var(--color-text-faint, hsl(40 6% 48%));
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
    color: var(--color-text, hsl(40 12% 95%));
  }
  .chain-item.is-default .model-name {
    color: var(--color-text-dim, hsl(40 8% 68%));
  }

  .model-info {
    display: flex;
    flex-direction: column;
    line-height: 1.25;
    min-width: 0;
  }
  .model-name {
    color: var(--color-text, hsl(40 12% 95%));
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .model-provider {
    color: var(--color-text-faint, hsl(40 6% 48%));
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 12px;
    letter-spacing: 0.02em;
  }

  .status-dot {
    background: hsl(142 70% 55%);
    border-radius: 50%;
    flex-shrink: 0;
    height: 6px;
    width: 6px;
  }
  .status-dot.locked {
    background: hsl(40 6% 55%);
  }

  .default-pill {
    border: 1px solid var(--color-border-2, hsl(220 6% 24%));
    border-radius: 999px;
    color: var(--color-text-faint, hsl(40 6% 48%));
    font-family: var(--font-mono, ui-monospace, monospace);
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
    color: var(--color-text-faint, hsl(40 6% 48%));
    cursor: pointer;
    font-family: inherit;
    font-size: 12px;
    padding: 4px 6px;
    transition:
      background 120ms ease,
      color 120ms ease;
  }
  .chain-btn:hover {
    background: var(--color-surface-4, hsl(220 8% 17%));
    color: var(--color-text, hsl(40 12% 95%));
  }
  .chain-btn.override {
    padding: 4px 10px;
  }

  .add-fallback {
    align-items: center;
    background: transparent;
    border: 1px dashed var(--color-border-2, hsl(220 6% 24%));
    border-radius: 6px;
    color: var(--color-text-faint, hsl(40 6% 48%));
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
    border-color: var(--color-border-strong, hsl(220 6% 34%));
    color: var(--color-text-dim, hsl(40 8% 68%));
  }
  .plus {
    font-size: 16px;
    line-height: 1;
  }

  .warn-pill {
    align-items: center;
    color: hsl(38 92% 60%);
    display: inline-flex;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 12px;
    gap: 6px;
    margin-top: 2px;
  }
  .warn-pill::before {
    background: hsl(38 92% 60%);
    border-radius: 50%;
    content: "";
    height: 6px;
    width: 6px;
  }
</style>
