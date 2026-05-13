/**
 * Serialize a rendered `<table>` element back into a GitHub-flavored
 * markdown table. Used by the chat-message-list copy button so a copied
 * table pastes cleanly into Slack / GitHub / Linear / Notion / plain
 * text editors as a real table rather than a wall of TSV.
 *
 * Pairs with the HTML clipboard slot the copy button writes alongside:
 * the markdown is `text/plain`, the original `<table>` outerHTML is
 * `text/html`, so spreadsheet destinations (Excel, Sheets, Word) read
 * the HTML and get proper cells while text destinations get the
 * markdown source.
 *
 * Pipes inside cell text are escaped (`\|`) because an unescaped pipe
 * would break the row into extra columns when re-rendered. Newlines
 * inside cells collapse to a single space — markdown tables can't
 * carry hard newlines inside a cell, and `<br>` would be misleading
 * for paste destinations that don't render HTML.
 *
 * No-op safe: returns an empty string for tables with zero rows.
 */
export function tableToMarkdown(table: HTMLTableElement): string {
  const rows: string[][] = [];
  let headerRowIndex = -1;
  let rowIndex = 0;
  for (const tr of table.querySelectorAll("tr")) {
    const cells: string[] = [];
    let sawThisRowAsHeader = false;
    for (const cell of tr.querySelectorAll("th, td")) {
      if (cell.tagName === "TH") sawThisRowAsHeader = true;
      const raw = (cell as HTMLElement).textContent ?? "";
      cells.push(escapeCell(raw));
    }
    if (cells.length === 0) {
      rowIndex++;
      continue;
    }
    if (sawThisRowAsHeader && headerRowIndex === -1) headerRowIndex = rows.length;
    rows.push(cells);
    rowIndex++;
  }
  if (rows.length === 0) return "";

  // Pad ragged rows to the widest row's column count so the markdown
  // stays well-formed when a source table is missing trailing cells.
  const width = Math.max(...rows.map((r) => r.length));
  for (const r of rows) while (r.length < width) r.push("");

  const lines: string[] = [];
  // If no `<th>` was present, synthesize a header by treating the first
  // row as the header so the markdown still has the required separator
  // line — markdown spec requires it for the table to render at all.
  const effectiveHeaderIdx = headerRowIndex === -1 ? 0 : headerRowIndex;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    lines.push(`| ${row.join(" | ")} |`);
    if (i === effectiveHeaderIdx) {
      lines.push(`| ${row.map(() => "---").join(" | ")} |`);
    }
  }
  return lines.join("\n");
}

function escapeCell(text: string): string {
  return text
    .trim()
    // Collapse internal whitespace runs (including newlines) to a
    // single space — markdown cells are single-line.
    .replace(/\s+/g, " ")
    // Escape pipes so they don't get parsed as cell separators.
    .replace(/\|/g, "\\|");
}
