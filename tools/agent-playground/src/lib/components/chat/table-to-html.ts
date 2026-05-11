/**
 * Serialize a rendered `<table>` element to clean HTML suitable for the
 * clipboard's `text/html` slot. Only emits the structural table tags
 * (`<table>/<thead>/<tbody>/<tr>/<th>/<td>`) and writes cells via
 * `textContent` so any embedded `<script>`, event-handler attributes,
 * inline styles, or other tags from the source HTML are dropped.
 *
 * Why this exists separate from `tableToMarkdown` / `tableToCSV`: the
 * inline chat path renders agent-emitted markdown through the chat's
 * own safe-markdown renderer, but the dedicated table-view route can
 * be opened against any artifact bytes — including user-uploaded HTML
 * via `write_file` + create_artifact. If we naively did
 * `table.outerHTML` on a parsed table from such an artifact, embedded
 * `<script>` tags would survive into the clipboard payload and could
 * execute when pasted into rich-text destinations that don't sanitize
 * (some webmail composers, some CMSes, some IDEs).
 *
 * The serializer never touches attributes, never preserves inline
 * formatting (`<strong>`, `<a>`, etc), and never copies images.
 * That's a deliberate trade — the clipboard's `text/plain` slot
 * carries faithful markdown alongside, so destinations that want
 * structure use the HTML and destinations that want fidelity use the
 * markdown.
 *
 * Output is minified — single line, no whitespace between tags — so
 * pastes into spreadsheets cleanly without phantom blank cells from
 * indentation text nodes.
 */
export function tableToSafeHTML(table: HTMLTableElement): string {
  const parts: string[] = ["<table>"];
  let inThead = false;
  for (const tr of table.querySelectorAll("tr")) {
    const cells = Array.from(tr.querySelectorAll("th, td"));
    if (cells.length === 0) continue;
    const isHeaderRow = cells.every((c) => c.tagName === "TH");
    if (isHeaderRow && !inThead) {
      parts.push("<thead>");
      inThead = true;
    } else if (!isHeaderRow && inThead) {
      parts.push("</thead><tbody>");
      inThead = false;
    } else if (!isHeaderRow && parts.length === 1) {
      // No header row at all — open tbody so the tree is well-formed.
      parts.push("<tbody>");
    }
    parts.push("<tr>");
    for (const cell of cells) {
      const tag = cell.tagName === "TH" ? "th" : "td";
      parts.push(`<${tag}>${escapeCell((cell as HTMLElement).textContent ?? "")}</${tag}>`);
    }
    parts.push("</tr>");
  }
  // Close whichever section we were in.
  parts.push(inThead ? "</thead>" : parts.length > 1 ? "</tbody>" : "");
  parts.push("</table>");
  return parts.join("");
}

/**
 * HTML-escape cell text. Covers the five characters that change parse
 * meaning in attribute-free element content: `&`, `<`, `>`, `"`, `'`.
 * Whitespace inside cells is preserved literally — the markdown
 * serializer collapses; the HTML serializer doesn't, because Sheets /
 * Excel honour explicit `<br>` and inline spaces faithfully.
 */
function escapeCell(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
