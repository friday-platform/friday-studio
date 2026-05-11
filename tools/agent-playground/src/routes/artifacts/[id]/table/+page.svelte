<!--
  Dedicated fullscreen table view for tabular artifacts. Lives at
  `/table/<artifactId>` (root-level, workspace-agnostic) and runs
  chrome-less — no sidebar, no workspace panel, full bleed edge to
  edge so wide tables get every available pixel. Opened in a new tab
  by both the ArtifactCard "Open" button (csv/tsv/json/html/markdown
  artifacts) and the inline-table Actions menu's "Open in dedicated
  view" path (which auto-snapshots the rendered <table> to a markdown
  artifact first so the URL is durable + shareable).

  Page anatomy:
    Header  Friday-brand (linked home) · filename + dims · Copy /
            Download CSV / Download MD. Same vertical height as the
            main-app sidebar header so the visual scale matches.
    Body    TableView filling the rest of the viewport.

  Read-only — editing is a deliberate non-goal for now. If the bytes
  don't parse as tabular in any shape we recognize, the route falls
  back to a graceful "this isn't tabular" panel with a link to the
  raw download so the user isn't stranded.
-->

<script lang="ts">
  import type { PageData } from "./$types";
  import {
    parseTabular,
    type TableModel,
  } from "$lib/components/chat/table-parsers.ts";
  import { tableToCSV } from "$lib/components/chat/table-to-csv.ts";
  import { tableToSafeHTML } from "$lib/components/chat/table-to-html.ts";
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
    // The detached <table> we just built has only `textContent` in
    // each cell (no rich HTML) so outerHTML would be safe here today.
    // Route through the sanitizing serializer anyway so a future
    // refactor of `buildDetachedTable` that adds links / images /
    // inline formatting can't slip an XSS shape into someone's
    // rich-text paste. See `table-to-html.ts` for the threat model.
    const html = tableToSafeHTML(table);
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

<div class="table-page">
  <header class="table-page-header">
    <!-- Friday brand on its own row at the top — sized to match the
         main-app sidebar so a user with both surfaces open sees the
         same visual anchor in the top-left. Linked home so this tab
         can navigate back to the workspace without the user re-typing
         a URL. -->
    <a class="brand" href="/" aria-label="Friday">
      <svg class="brand-logo" xmlns="http://www.w3.org/2000/svg" viewBox="-4.1 -0.2 26 26">
        <path
          d="M9.9375 14.9014C10.344 14.9014 10.6738 15.2312 10.6738 15.6377V20.2383C10.6737 23.1855 8.28412 25.5751 5.33691 25.5752C2.38962 25.5752 0.000158184 23.1855 0 20.2383C0 17.2909 2.38953 14.9014 5.33691 14.9014H9.9375ZM11.1377 0C14.8218 0.00013192 17.8086 2.98674 17.8086 6.6709C17.8086 10.3551 14.8218 13.3417 11.1377 13.3418H5.21289C4.80079 13.3418 4.46696 13.0078 4.4668 12.5957V6.6709C4.4668 2.98666 7.45346 0 11.1377 0Z"
          fill="#1171DF"
        />
      </svg>
      <span class="brand-name">Friday</span>
    </a>

    <!-- Title + actions on a second row below the brand. The title
         takes the leading edge; the action buttons auto-push to the
         trailing edge via margin-inline-start: auto. -->
    <div class="title-row">
      <div class="title">
        <h1>{data.filename}</h1>
        <div class="meta">
          {#if model}
            <span class="counts">
              {model.columns.length} column{model.columns.length === 1 ? "" : "s"} ·
              {model.rows.length} row{model.rows.length === 1 ? "" : "s"}
            </span>
          {/if}
          <!-- Provenance row: "From <chat> in <workspace>" with both
               linked back to the originating surfaces. Chat link is
               omitted when we can't resolve a title (legacy artifact
               with no chatId, deleted chat). Workspace link is shown
               whenever the artifact has a workspaceId — falls back to
               the id when name lookup fails so the link isn't dead. -->
          {#if data.chatTitle && data.workspaceId && data.chatId}
            <span class="provenance">
              From <a href="/platform/{encodeURIComponent(data.workspaceId)}/chat/{encodeURIComponent(data.chatId)}">{data.chatTitle}</a>
              in <a href="/platform/{encodeURIComponent(data.workspaceId)}">{data.workspaceName ?? data.workspaceId}</a>
            </span>
          {:else if data.workspaceId}
            <span class="provenance">
              in <a href="/platform/{encodeURIComponent(data.workspaceId)}">{data.workspaceName ?? data.workspaceId}</a>
            </span>
          {/if}
        </div>
      </div>

      <div class="actions">
        <button onclick={onCopy} disabled={!model}>{copyLabel}</button>
        <button onclick={onDownloadCSV} disabled={!model}>Download CSV</button>
        <button onclick={onDownloadMD} disabled={!model}>Download MD</button>
      </div>
    </div>
  </header>

  <div class="table-page-body">
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
</div>

<style>
  /* Full-bleed page: edge-to-edge horizontally so wide tables get
     every available pixel. 100dvh on block axis so mobile browser
     chrome doesn't eat the bottom of the table. */
  .table-page {
    block-size: 100dvh;
    display: flex;
    flex-direction: column;
    inline-size: 100%;
    overflow: hidden;
  }

  /* Header has two stacked rows:
        Row 1 — Friday brand (own block, matches sidebar's 20px logo +
                heading scale so a side-by-side tab comparison reads
                as the same app)
        Row 2 — file title + counts on the leading edge, action
                buttons (Copy / Download CSV / Download MD) auto-
                pushed to the trailing edge. */
  .table-page-header {
    background: var(--surface-dark);
    border-block-end: 1px solid var(--color-border-1);
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    gap: var(--size-3);
    padding-block: var(--size-3);
    padding-inline: var(--size-5);
  }

  .brand {
    align-items: center;
    align-self: flex-start;
    color: inherit;
    display: inline-flex;
    flex-shrink: 0;
    gap: var(--size-2);
    text-decoration: none;
  }
  .brand-logo {
    block-size: 20px;
    flex-shrink: 0;
    inline-size: 20px;
  }
  .brand-name {
    font-size: var(--font-size-5);
    font-weight: var(--font-weight-6);
  }

  .title-row {
    align-items: end;
    display: flex;
    flex-wrap: wrap;
    gap: var(--size-3);
  }

  .title {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-inline-size: 0;
  }
  .title h1 {
    color: var(--color-text);
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-6);
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta {
    align-items: center;
    color: color-mix(in srgb, var(--color-text), transparent 45%);
    display: flex;
    flex-wrap: wrap;
    font-size: var(--font-size-1);
    gap: var(--size-3);
  }
  .counts {
    font-variant-numeric: tabular-nums;
  }
  .provenance a {
    color: inherit;
    text-decoration: underline;
  }
  .provenance a:hover {
    color: var(--color-primary);
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

  /* Body fills the remaining vertical space. min-block-size:0 is
     necessary on flex children so the table's own overflow:auto
     scroll container has a bounded height to fight against. */
  .table-page-body {
    flex: 1;
    inline-size: 100%;
    min-block-size: 0;
    overflow: hidden;
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
