<!--
  Side-by-side version comparator — opens a modal showing a line-level
  diff between the currently-stored skill and a historical version, so
  the user can make an informed choice before clicking Restore.

  The diff itself is computed client-side via `diffLines()` from `diff`;
  unchanged regions collapse to `· N unchanged lines ·` placeholders so
  long SKILL.md bodies don't flood the dialog.

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

  /** Diff chunks or a collapsed-summary placeholder. */
  type Chunk =
    | { kind: "add" | "del" | "ctx"; text: string }
    | { kind: "collapsed"; lines: number };

  /** Collapse runs of >4 unchanged lines into a single `ctx collapsed` row. */
  function toChunks(oldText: string, newText: string): Chunk[] {
    const parts = diffLines(oldText, newText);
    const chunks: Chunk[] = [];
    for (const p of parts) {
      if (p.added) {
        chunks.push({ kind: "add", text: p.value });
      } else if (p.removed) {
        chunks.push({ kind: "del", text: p.value });
      } else {
        const lines = p.value.split("\n");
        // A trailing "" comes from text that ends in \n — drop it.
        if (lines.at(-1) === "") lines.pop();
        if (lines.length > 6) {
          // Keep 2 lines of context on each side, collapse the middle.
          chunks.push({ kind: "ctx", text: `${lines.slice(0, 2).join("\n")}\n` });
          chunks.push({ kind: "collapsed", lines: lines.length - 4 });
          chunks.push({ kind: "ctx", text: `${lines.slice(-2).join("\n")}\n` });
        } else if (lines.length > 0) {
          chunks.push({ kind: "ctx", text: p.value });
        }
      }
    }
    return chunks;
  }

  const descriptionChunks = $derived.by(() => {
    if (!older.data) return [];
    return toChunks(older.data.description, currentDescription);
  });

  const instructionsChunks = $derived.by(() => {
    if (!older.data) return [];
    return toChunks(older.data.instructions, currentInstructions);
  });
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
            {#if descriptionChunks.length === 0 || descriptionChunks.every((c) => c.kind === "ctx")}
              <p class="status">No change.</p>
            {:else}
              <pre class="diff">{#each descriptionChunks as c (c)}{#if c.kind === "add"}<span class="add">{c.text}</span>{:else if c.kind === "del"}<span class="del">{c.text}</span>{:else if c.kind === "collapsed"}<span class="collapsed">· {c.lines} unchanged lines ·
</span>{:else}<span class="ctx">{c.text}</span>{/if}{/each}</pre>
            {/if}
          </section>

          <section>
            <h3>Instructions</h3>
            {#if instructionsChunks.length === 0 || instructionsChunks.every((c) => c.kind === "ctx")}
              <p class="status">No change.</p>
            {:else}
              <pre class="diff">{#each instructionsChunks as c (c)}{#if c.kind === "add"}<span class="add">{c.text}</span>{:else if c.kind === "del"}<span class="del">{c.text}</span>{:else if c.kind === "collapsed"}<span class="collapsed">· {c.lines} unchanged lines ·
</span>{:else}<span class="ctx">{c.text}</span>{/if}{/each}</pre>
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
    gap: var(--size-4);
    /* Dialog uses `size="auto"` (no max-inline-size) — explicitly claim a
       wide-but-bounded box here so long SKILL.md bodies render with enough
       horizontal room for the diff to be legible. */
    inline-size: min(1100px, 90vw);
    /* Dialog content is already scroll-managed; keep diffs tall but bounded. */
    max-block-size: 70vh;
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

  .diff {
    background-color: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-3);
    font-family: var(--font-mono, monospace);
    font-size: var(--font-size-1);
    line-height: var(--font-lineheight-1);
    margin: 0;
    overflow-x: auto;
    padding: var(--size-3);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .add {
    background-color: color-mix(in oklch, var(--color-success, green), transparent 80%);
    color: var(--color-success, limegreen);
    display: block;
  }

  .del {
    background-color: color-mix(in oklch, var(--color-error), transparent 80%);
    color: var(--color-error);
    display: block;
    text-decoration: line-through;
  }

  .collapsed {
    color: color-mix(in srgb, var(--color-text), transparent 60%);
    display: block;
    font-style: italic;
    text-align: center;
  }

  .ctx {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    display: block;
  }
</style>
