/**
 * Shared serialization helpers for a `TableModel`. Used by the dedicated
 * `/artifacts/[id]/table` page and by the inline-table chrome inside the
 * markdown viewer.
 *
 * The model → detached-DOM step exists because the existing
 * `tableTo{CSV,Markdown,SafeHTML}` serializers consume DOM nodes. Sharing
 * them keeps every Copy / Download path producing byte-identical output
 * regardless of which surface emitted it.
 */

import type { TableModel } from "./table-parsers.ts";
import { tableToCSV } from "./table-to-csv.ts";
import { tableToSafeHTML } from "./table-to-html.ts";
import { tableToMarkdown } from "./table-to-markdown.ts";

/**
 * Build a detached `<table>` from a `TableModel`. Cheap (<10ms even for
 * thousands of rows). Returned node is not attached to the document — the
 * caller hands it to a serializer and discards it.
 */
export function buildDetachedTable(model: TableModel): HTMLTableElement {
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  for (const col of model.columns) {
    const th = document.createElement("th");
    th.textContent = col;
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  for (const row of model.rows) {
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

export function copyTableToClipboard(model: TableModel): Promise<void> {
  const table = buildDetachedTable(model);
  const md = tableToMarkdown(table);
  // The detached <table> built here has only `textContent` per cell — no
  // rich HTML, so outerHTML would be safe today. Route through the
  // sanitizing serializer anyway so a future refactor that adds links or
  // images can't slip an XSS shape into someone's rich-text paste. See
  // `table-to-html.ts` for the threat model.
  const html = tableToSafeHTML(table);
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard.write) {
    return navigator.clipboard.write([
      new ClipboardItem({
        "text/plain": new Blob([md], { type: "text/plain" }),
        "text/html": new Blob([html], { type: "text/html" }),
      }),
    ]);
  }
  return navigator.clipboard.writeText(md);
}

function withoutExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
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
  // Revoke after the click so the browser doesn't dangle the object URL —
  // small leak in long sessions otherwise.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function downloadTableCSV(model: TableModel, baseFilename: string): void {
  const csv = tableToCSV(buildDetachedTable(model));
  downloadBlob(csv, "text/csv", `${withoutExtension(baseFilename)}.csv`);
}

export function downloadTableMarkdown(model: TableModel, baseFilename: string): void {
  const md = tableToMarkdown(buildDetachedTable(model));
  downloadBlob(md, "text/markdown", `${withoutExtension(baseFilename)}.md`);
}
