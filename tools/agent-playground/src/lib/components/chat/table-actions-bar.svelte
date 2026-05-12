<!--
  Three-button action bar (Copy / Download CSV / Download MD) bound to a
  TableModel. Used by the dedicated `/artifacts/[id]/table` page in its
  header, and by the markdown viewer above each embedded GFM table.

  Layout is intentionally minimal — a flex row of buttons. The hosting
  page decides positioning (sticky top, inline above a table, etc.).
-->

<script lang="ts">
  import {
    copyTableToClipboard,
    downloadTableCSV,
    downloadTableMarkdown,
  } from "./table-action-helpers.ts";
  import type { TableModel } from "./table-parsers.ts";

  interface Props {
    model: TableModel;
    /**
     * Base filename for the downloaded CSV / MD files. The extension is
     * stripped before re-appending the correct one per format.
     */
    filename: string;
  }

  const { model, filename }: Props = $props();

  let copyState = $state<"idle" | "ok" | "err">("idle");

  function flashCopy(state: "ok" | "err"): void {
    copyState = state;
    setTimeout(() => {
      copyState = "idle";
    }, 1500);
  }

  function onCopy(): void {
    void copyTableToClipboard(model).then(
      () => flashCopy("ok"),
      () => flashCopy("err"),
    );
  }

  const copyLabel = $derived(
    copyState === "ok" ? "Copied!" : copyState === "err" ? "Copy failed" : "Copy",
  );
</script>

<div class="actions">
  <button onclick={onCopy}>{copyLabel}</button>
  <button onclick={() => downloadTableCSV(model, filename)}>Download CSV</button>
  <button onclick={() => downloadTableMarkdown(model, filename)}>Download MD</button>
</div>

<style>
  .actions {
    display: flex;
    gap: var(--size-2);
  }
  .actions button {
    background-color: var(--surface, transparent);
    border: 1px solid color-mix(in srgb, var(--color-border-1), transparent 30%);
    border-radius: var(--radius-2);
    color: var(--color-text);
    cursor: pointer;
    font: inherit;
    padding: var(--size-1) var(--size-3);
  }
  .actions button:hover {
    background-color: color-mix(in srgb, var(--color-text), transparent 92%);
  }
</style>
