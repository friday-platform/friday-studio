<!--
  GitHub-style unified diff viewer for skill version comparison.

  Lays the diff out as a 4-column table: old-line-number, new-line-number,
  `+/-/ ` prefix, content. Added lines get a green row tint and `+` in
  the gutter; removed lines get red and `-`. Unchanged context shows both
  line numbers with no tint. Long unchanged runs collapse into a single
  "N unchanged lines" row.

  @component
-->
<script lang="ts">
  import { Button, Dialog } from "@atlas/ui";
  import { diffLines } from "diff";
  import { useSkillAtVersion } from "$lib/queries/skills";
  import { writable } from "svelte/store";

  interface Props {
    namespace: string;
    name: string;
    currentVersion: number;
    currentDescription: string;
    currentInstructions: string;
    /** Version to compare against. When null, the dialog is hidden. */
    targetVersion: number | null;
    onclose: () => void;
    onrestore: (version: number) => void;
    restoring?: boolean;
  }

  const {
    namespace,
    name,
    currentVersion,
    currentDescription,
    currentInstructions,
    targetVersion,
    onclose,
    onrestore,
    restoring = false,
  }: Props = $props();

  const open = writable(true);
  const older = useSkillAtVersion(
    () => namespace,
    () => name,
    () => targetVersion,
  );

  /** One row of the unified diff table. */
  type Row =
    | { kind: "add"; oldNo: null; newNo: number; text: string }
    | { kind: "del"; oldNo: number; newNo: null; text: string }
    | { kind: "ctx"; oldNo: number; newNo: number; text: string }
    | { kind: "collapsed"; lines: number };

  /** How many context lines to keep around changed regions. */
  const CONTEXT_LINES = 3;

  /**
   * Compute a unified diff and collapse long unchanged runs. Mirrors
   * GitHub's hunk rendering: keeps N lines of context on both sides of
   * each change, collapses the middle into a "N unchanged lines" row.
   */
  function toRows(oldText: string, newText: string): Row[] {
    const parts = diffLines(oldText, newText);
    const rows: Row[] = [];
    let oldLine = 1;
    let newLine = 1;

    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (!p) continue;
      const lines = p.value.split("\n");
      // `diffLines` keeps a trailing newline, so the last element is empty.
      if (lines.at(-1) === "") lines.pop();

      if (p.added) {
        for (const line of lines) {
          rows.push({ kind: "add", oldNo: null, newNo: newLine++, text: line });
        }
      } else if (p.removed) {
        for (const line of lines) {
          rows.push({ kind: "del", oldNo: oldLine++, newNo: null, text: line });
        }
      } else {
        const isFirst = i === 0;
        const isLast = i === parts.length - 1;
        if (lines.length > CONTEXT_LINES * 2 && !isFirst && !isLast) {
          // Head: `CONTEXT_LINES` rows of context after the previous change.
          for (let j = 0; j < CONTEXT_LINES; j++) {
            const t = lines[j] ?? "";
            rows.push({ kind: "ctx", oldNo: oldLine++, newNo: newLine++, text: t });
          }
          const middle = lines.length - CONTEXT_LINES * 2;
          oldLine += middle;
          newLine += middle;
          rows.push({ kind: "collapsed", lines: middle });
          // Tail: `CONTEXT_LINES` rows of context before the next change.
          for (let j = lines.length - CONTEXT_LINES; j < lines.length; j++) {
            const t = lines[j] ?? "";
            rows.push({ kind: "ctx", oldNo: oldLine++, newNo: newLine++, text: t });
          }
        } else if (isFirst && lines.length > CONTEXT_LINES) {
          // Leading context: keep only the last N lines before the first change.
          oldLine += lines.length - CONTEXT_LINES;
          newLine += lines.length - CONTEXT_LINES;
          rows.push({ kind: "collapsed", lines: lines.length - CONTEXT_LINES });
          for (let j = lines.length - CONTEXT_LINES; j < lines.length; j++) {
            const t = lines[j] ?? "";
            rows.push({ kind: "ctx", oldNo: oldLine++, newNo: newLine++, text: t });
          }
        } else if (isLast && lines.length > CONTEXT_LINES) {
          // Trailing context: keep only the first N lines after the last change.
          for (let j = 0; j < CONTEXT_LINES; j++) {
            const t = lines[j] ?? "";
            rows.push({ kind: "ctx", oldNo: oldLine++, newNo: newLine++, text: t });
          }
          rows.push({ kind: "collapsed", lines: lines.length - CONTEXT_LINES });
          oldLine += lines.length - CONTEXT_LINES;
          newLine += lines.length - CONTEXT_LINES;
        } else {
          for (const line of lines) {
            rows.push({ kind: "ctx", oldNo: oldLine++, newNo: newLine++, text: line });
          }
        }
      }
    }
    return rows;
  }

  const descriptionRows = $derived.by(() => {
    if (!older.data) return [];
    return toRows(older.data.description, currentDescription);
  });
  const instructionsRows = $derived.by(() => {
    if (!older.data) return [];
    return toRows(older.data.instructions, currentInstructions);
  });

  function hasChanges(rows: Row[]): boolean {
    return rows.some((r) => r.kind === "add" || r.kind === "del");
  }
</script>

<Dialog.Root {open}>
  {#snippet children()}
    <Dialog.Content size="auto">
      <Dialog.Close />

      {#snippet header()}
        <Dialog.Title>
          Compare v{targetVersion} → v{currentVersion}
        </Dialog.Title>
        <Dialog.Description>
          Red lines were in v{targetVersion}; green lines are in the current version.
          Restoring publishes v{targetVersion}'s content as a new version (history is preserved).
        </Dialog.Description>
      {/snippet}

      <div class="body">
        {#if older.isPending}
          <p class="status">Loading v{targetVersion}…</p>
        {:else if older.isError}
          <p class="status error">Failed to load v{targetVersion}: {older.error.message}</p>
        {:else if older.data}
          <section>
            <h3>Description</h3>
            {#if !hasChanges(descriptionRows)}
              <p class="status">No change.</p>
            {:else}
              <div class="diff">
                <table>
                  <tbody>
                    {#each descriptionRows as r, i (i)}
                      {#if r.kind === "collapsed"}
                        <tr class="row-collapsed">
                          <td class="gutter" colspan="3"></td>
                          <td class="content">· {r.lines} unchanged line{r.lines === 1 ? "" : "s"} ·</td>
                        </tr>
                      {:else}
                        <tr class="row-{r.kind}">
                          <td class="num num-old">{r.oldNo ?? ""}</td>
                          <td class="num num-new">{r.newNo ?? ""}</td>
                          <td class="marker">{r.kind === "add" ? "+" : r.kind === "del" ? "-" : " "}</td>
                          <td class="content">{r.text}</td>
                        </tr>
                      {/if}
                    {/each}
                  </tbody>
                </table>
              </div>
            {/if}
          </section>

          <section>
            <h3>Instructions</h3>
            {#if !hasChanges(instructionsRows)}
              <p class="status">No change.</p>
            {:else}
              <div class="diff">
                <table>
                  <tbody>
                    {#each instructionsRows as r, i (i)}
                      {#if r.kind === "collapsed"}
                        <tr class="row-collapsed">
                          <td class="gutter" colspan="3"></td>
                          <td class="content">· {r.lines} unchanged line{r.lines === 1 ? "" : "s"} ·</td>
                        </tr>
                      {:else}
                        <tr class="row-{r.kind}">
                          <td class="num num-old">{r.oldNo ?? ""}</td>
                          <td class="num num-new">{r.newNo ?? ""}</td>
                          <td class="marker">{r.kind === "add" ? "+" : r.kind === "del" ? "-" : " "}</td>
                          <td class="content">{r.text}</td>
                        </tr>
                      {/if}
                    {/each}
                  </tbody>
                </table>
              </div>
            {/if}
          </section>
        {/if}
      </div>

      {#snippet footer()}
        <Button
          variant="primary"
          disabled={!older.data || restoring}
          onclick={() => {
            if (targetVersion !== null) onrestore(targetVersion);
          }}
        >
          {restoring ? "Restoring…" : `Restore v${targetVersion}`}
        </Button>
        <Dialog.Cancel onclick={onclose}>Close</Dialog.Cancel>
      {/snippet}
    </Dialog.Content>
  {/snippet}
</Dialog.Root>

<style>
  .body {
    display: flex;
    flex-direction: column;
    gap: var(--size-5);
    inline-size: min(1200px, 92vw);
    max-block-size: 72vh;
    overflow-y: auto;
    padding: var(--size-2) 0;
    text-align: start;
  }

  section {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  h3 {
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-6);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .status {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-2);
    font-style: italic;
  }

  .status.error {
    color: var(--color-error);
    font-style: normal;
  }

  /* --- Unified diff table ---------------------------------------------------- */

  .diff {
    background-color: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-3);
    overflow: hidden;
  }

  table {
    border-collapse: collapse;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: var(--font-size-1);
    inline-size: 100%;
    line-height: var(--font-lineheight-1);
    table-layout: fixed;
  }

  td {
    padding: 0;
    vertical-align: top;
  }

  .num {
    color: color-mix(in srgb, var(--color-text), transparent 55%);
    inline-size: 3.5em;
    max-inline-size: 3.5em;
    padding-block: 1px;
    padding-inline: var(--size-2);
    text-align: end;
    user-select: none;
    -webkit-user-select: none;
  }

  .marker {
    inline-size: 1.5em;
    max-inline-size: 1.5em;
    padding-inline: var(--size-1);
    text-align: center;
    user-select: none;
    -webkit-user-select: none;
  }

  .content {
    overflow-wrap: break-word;
    padding-block: 1px;
    padding-inline-end: var(--size-2);
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* Add-row (green), matching GitHub's diffAdditionBg */
  .row-add td {
    background-color: color-mix(in oklch, var(--color-success, #238636), transparent 82%);
  }
  .row-add .marker,
  .row-add .content {
    color: color-mix(in oklch, var(--color-success, #3fb950), black 10%);
  }
  .row-add .num {
    background-color: color-mix(in oklch, var(--color-success, #238636), transparent 72%);
  }

  /* Del-row (red), matching GitHub's diffDeletionBg */
  .row-del td {
    background-color: color-mix(in oklch, var(--color-error, #f85149), transparent 82%);
  }
  .row-del .marker,
  .row-del .content {
    color: color-mix(in oklch, var(--color-error, #ff7b72), black 10%);
  }
  .row-del .num {
    background-color: color-mix(in oklch, var(--color-error, #f85149), transparent 72%);
  }

  .row-ctx .num {
    background-color: color-mix(in srgb, var(--color-surface-2), var(--color-text) 4%);
  }

  .row-collapsed td {
    background-color: color-mix(in srgb, var(--color-surface-2), var(--color-text) 5%);
    border-block: 1px solid var(--color-border-1);
    color: color-mix(in srgb, var(--color-text), transparent 45%);
    font-style: italic;
    padding-block: var(--size-1);
    text-align: center;
  }
</style>
