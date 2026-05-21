<!--
  Per-workspace conversational model override pill. Shows the model that
  will be used for the next message in this workspace, sourced from:

    1. localStorage (`model-override-<wsId>`) — if set, takes precedence.
    2. Daemon's resolved `conversational` model from `/api/config/models` —
       the global default.

  Clicking opens the existing <ModelPicker> modal (reused unchanged from
  the settings page) scoped to conversational. Selecting a model writes
  the override; "Use default chain" clears it.
-->
<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import { getModelOverride, setModelOverride } from "$lib/model-override-storage.ts";
  import ModelPicker from "../settings/model-picker.svelte";
  import ProviderMark from "../settings/provider-mark.svelte";
  import {
    parseOverride,
    resolvePillLabel,
    type CatalogEntry,
    type ModelInfo,
    type PillLabel,
  } from "./model-pill.ts";

  interface Props {
    workspaceId: string;
  }

  const { workspaceId }: Props = $props();

  // Writable derived: re-reads localStorage on workspace change, locally
  // assignable after the picker writes so the pill updates immediately
  // without waiting for a workspace-prop change.
  let override = $derived(getModelOverride(workspaceId));

  const modelsQuery = createQuery<ModelInfo[]>(() => ({
    queryKey: ["daemon", "config", "models"] as const,
    queryFn: async () => {
      const res = await fetch("/api/daemon/api/config/models");
      if (!res.ok) throw new Error(`Failed to load models (HTTP ${res.status})`);
      const data: unknown = await res.json();
      if (
        typeof data === "object" &&
        data !== null &&
        "models" in data &&
        Array.isArray((data as { models: unknown }).models)
      ) {
        return (data as { models: ModelInfo[] }).models;
      }
      return [];
    },
    staleTime: 60_000,
  }));

  const catalogQuery = createQuery<CatalogEntry[]>(() => ({
    queryKey: ["daemon", "config", "models", "catalog"] as const,
    queryFn: async () => {
      const res = await fetch("/api/daemon/api/config/models/catalog");
      if (!res.ok) throw new Error(`Failed to load catalog (HTTP ${res.status})`);
      const data: unknown = await res.json();
      if (
        typeof data === "object" &&
        data !== null &&
        "entries" in data &&
        Array.isArray((data as { entries: unknown }).entries)
      ) {
        return (data as { entries: CatalogEntry[] }).entries;
      }
      return [];
    },
    staleTime: 60_000,
  }));

  const label = $derived<PillLabel | null>(
    resolvePillLabel(override, modelsQuery.data ?? [], catalogQuery.data ?? []),
  );

  const pickerCurrent = $derived(parseOverride(override));

  let pickerOpen = $state(false);

  function handleSelect(choice: { provider: string; modelId: string } | null): void {
    const spec = choice === null ? null : `${choice.provider}:${choice.modelId}`;
    setModelOverride(workspaceId, spec);
    override = spec;
    pickerOpen = false;
  }

  // The picker's "Save & unlock" flow is not relevant to the per-chat
  // override — credentialed providers only. Reject locked unlocks here
  // (the user can configure credentials on the Settings page).
  async function rejectSaveApiKey(): Promise<null> {
    return null;
  }
</script>

<button
  type="button"
  class="model-pill"
  onclick={() => (pickerOpen = true)}
  title={label
    ? `${label.providerName} · ${label.modelDisplayName}${override ? " (override)" : " (default)"}`
    : "Pick conversational model"}
  aria-label="Pick conversational model"
>
  {#if label}
    <ProviderMark provider={label.provider} letter={label.providerLetter} size="sm" />
    <span class="model-pill-name">{label.modelDisplayName}</span>
  {:else}
    <span class="model-pill-name model-pill-placeholder">Model…</span>
  {/if}
</button>

{#if pickerOpen}
  <ModelPicker
    roleTitle="Conversational"
    slotLabel="this chat"
    current={pickerCurrent}
    allowDefault={true}
    catalog={catalogQuery.data ?? []}
    saveApiKey={rejectSaveApiKey}
    onSelect={handleSelect}
    onClose={() => (pickerOpen = false)}
  />
{/if}

<style>
  .model-pill {
    align-items: center;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: 999px;
    color: var(--color-text-dim, var(--color-text));
    cursor: pointer;
    display: inline-flex;
    flex-shrink: 0;
    font-family: inherit;
    font-size: var(--font-size-1);
    gap: var(--size-2);
    max-inline-size: 220px;
    min-block-size: var(--size-6);
    padding: 2px var(--size-2) 2px 4px;
    transition:
      background 120ms ease,
      border-color 120ms ease;
  }
  .model-pill:hover {
    background: var(--color-surface-3);
    border-color: var(--color-border-2, var(--color-border-1));
    color: var(--color-text);
  }
  .model-pill-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .model-pill-placeholder {
    color: color-mix(in srgb, var(--color-text), transparent 60%);
  }
</style>
