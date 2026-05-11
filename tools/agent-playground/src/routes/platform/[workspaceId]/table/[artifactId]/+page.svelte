<!--
  Dedicated fullscreen table view for tabular artifacts.

  Loaded from anywhere that points at `/platform/<wsId>/table/<artifactId>`:
    - ArtifactCard "Open" button for csv/tsv/json/html/markdown artifacts
    - The inline-table Actions dropdown's "Open in dedicated view" path
      (which auto-snapshots the in-chat <table> to an artifact first)

  Page anatomy:
    - Header bar  : filename + Copy (MD+HTML) / Download CSV / Download MD
    - Body        : TableView filling the rest of the viewport

  Cell content is read-only — editing is a deliberate non-goal for v1.
  If the artifact bytes don't parse into a tabular model the route
  shows a graceful fallback with a link back to the raw download so
  the user isn't stranded.
-->

<script lang="ts">
  import { PageLayout } from "@atlas/ui";
  import type { PageData } from "./$types";
  import {
    parseTabular,
    type TableModel,
  } from "$lib/components/chat/table-parsers.ts";
  import { tableToCSV } from "$lib/components/chat/table-to-csv.ts";
  import { tableToMarkdown } from "$lib/components/chat/table-to-markdown.ts";
  import TableView from "$lib/components/chat/table-view.svelte";

  const { data }: { data: PageData } = $props();

  // Parse the artifact bytes once on mount. Re-runs on data change so
  // navigating between table artifacts inside the same workspace
  // updates without a full reload.
  const model = $derived<TableModel | null>(parseTabular(data.mimeType, data.text));

  // Lazy-build a detached <table> DOM node from the parsed model so
  // the existing tableToMarkdown / tableToCSV serializers can be
  // reused (they consume DOM, not the model). The node is built
  // exactly once per model — cheap (<10ms even for thousands of
  // rows) and lets us share the serializers with the inline-chat
  // copy path so the export formats stay consistent.
  function buildDetachedTable(m: TableModel): HTMLTableElement {
    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");
    for (const col of m.columns) {
      const th = document.createElement("th");
      th.textContent = col;
      headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    for (const row of m.rows) {
      const tr = document.createElement("tr");
      for (const cell of row) {
        const td = document.createElement("td");
        td.textContent = cell;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    return table;
  }

  let copyState = $state<"idle" | "ok" | "err">("idle");
  function flashCopy(state: "ok" | "err"): void {
    copyState = state;
    setTimeout(() => {
      copyState = "idle";
    }, 1500);
  }

  function downloadBlob(text: string, mime: string, filename: string): void {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoke after the click so the browser doesn't dangle the
    // object URL — small leak in long sessions otherwise.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function onCopy(): void {
    if (!model) return;
    const table = buildDetachedTable(model);
    const md = tableToMarkdown(table);
    const html = table.outerHTML;
    const writeMulti =
      typeof ClipboardItem !== "undefined" && navigator.clipboard.write
        ? navigator.clipboard.write([
            new ClipboardItem({
              "text/plain": new Blob([md], { type: "text/plain" }),
              "text/html": new Blob([html], { type: "text/html" }),
            }),
          ])
        : navigator.clipboard.writeText(md);
    void writeMulti.then(
      () => flashCopy("ok"),
      () => flashCopy("err"),
    );
  }

  function onDownloadCSV(): void {
    if (!model) return;
    const table = buildDetachedTable(model);
    const csv = tableToCSV(table);
    downloadBlob(csv, "text/csv", `${withoutExtension(data.filename)}.csv`);
  }

  function onDownloadMD(): void {
    if (!model) return;
    const table = buildDetachedTable(model);
    const md = tableToMarkdown(table);
    downloadBlob(md, "text/markdown", `${withoutExtension(data.filename)}.md`);
  }

  function withoutExtension(name: string): string {
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(0, dot) : name;
  }

  const copyLabel = $derived(
    copyState === "ok" ? "Copied!" : copyState === "err" ? "Copy failed" : "Copy",
  );
</script>

<PageLayout.Root>
  <PageLayout.Body>
    <PageLayout.Content>
      <header class="table-header">
        <div class="title">
          <h1>{data.filename}</h1>
          {#if model}
            <span class="counts">
              {model.columns.length} column{model.columns.length === 1 ? "" : "s"} ·
              {model.rows.length} row{model.rows.length === 1 ? "" : "s"}
            </span>
          {/if}
        </div>
        <div class="actions">
          <button onclick={onCopy} disabled={!model}>{copyLabel}</button>
          <button onclick={onDownloadCSV} disabled={!model}>Download CSV</button>
          <button onclick={onDownloadMD} disabled={!model}>Download MD</button>
        </div>
      </header>

      <div class="table-body">
        {#if model}
          <TableView columns={model.columns} rows={model.rows} />
        {:else}
          <div class="empty">
            <p>This artifact's contents don't look tabular.</p>
            <span class="empty-hint">
              MIME type: <code>{data.mimeType}</code>
            </span>
            <a class="raw-link" href={data.contentUrl} download={data.filename}>
              Download the original file →
            </a>
          </div>
        {/if}
      </div>
    </PageLayout.Content>
  </PageLayout.Body>
</PageLayout.Root>

<style>
  .table-header {
    align-items: end;
    border-block-end: 1px solid var(--color-border-1);
    display: flex;
    flex-wrap: wrap;
    gap: var(--size-3);
    margin-block-end: var(--size-3);
    padding-block-end: var(--size-3);
  }

  .title {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
    min-inline-size: 0;
  }

  .title h1 {
    color: var(--color-text);
    font-size: var(--font-size-4);
    font-weight: var(--font-weight-6);
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .counts {
    color: color-mix(in srgb, var(--color-text), transparent 45%);
    font-size: var(--font-size-1);
  }

  .actions {
    display: flex;
    gap: var(--size-2);
    margin-inline-start: auto;
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
  .actions button:hover:not(:disabled) {
    background-color: color-mix(in srgb, var(--color-text), transparent 92%);
  }
  .actions button:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  /* Body fills the remaining vertical space so the TableView's own
     vertical scroll has something to operate against. */
  .table-body {
    block-size: calc(100vh - 12rem);
    inline-size: 100%;
    min-block-size: 20rem;
  }

  .empty {
    align-items: center;
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    padding: var(--size-12) 0;
    text-align: center;
  }
  .empty-hint {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-1);
  }
  .empty-hint code {
    font-family: monospace;
  }
  .raw-link {
    color: var(--color-primary);
    text-decoration: underline;
  }
</style>
