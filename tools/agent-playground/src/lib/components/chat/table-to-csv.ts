/**
 * Serialize a rendered `<table>` element to RFC-4180 CSV. Used by the
 * dedicated table-view route's "Download CSV" button and by any other
 * surface that wants spreadsheet-ready text from a chat-rendered table.
 *
 * RFC-4180 rules applied:
 *   - Fields are comma-separated, rows separated by `\r\n` (the RFC
 *     literal — Excel and Sheets both accept `\n` too, but the RFC
 *     pin avoids "what newline" arguments and matches what every CSV
 *     library emits by default).
 *   - A cell is quoted if it contains a comma, double-quote, or any
 *     newline character. Internal double-quotes are doubled (`"" `).
 *   - Cells that are safe (no special chars) are emitted bare.
 *
 * `text/csv` is what spreadsheets prefer for paste; the dedicated view
 * also writes `text/html` alongside via the clipboard API for the
 * paste-into-Sheets case, so this serializer is mainly for the
 * downloaded file. The two stay in sync because both read the same
 * `<table>` source.
 */
export function tableToCSV(table: HTMLTableElement): string {
  const lines: string[] = [];
  for (const tr of table.querySelectorAll("tr")) {
    const cells: string[] = [];
    for (const cell of tr.querySelectorAll("th, td")) {
      cells.push(escapeCell((cell as HTMLElement).textContent ?? ""));
    }
    if (cells.length > 0) lines.push(cells.join(","));
  }
  return lines.join("\r\n");
}

function escapeCell(text: string): string {
  const trimmed = text.trim();
  // Quote iff the cell contains a comma, double-quote, CR, or LF.
  // Otherwise bare — fewer bytes, easier to eyeball in a text editor.
  const needsQuoting = /[",\r\n]/.test(trimmed);
  if (!needsQuoting) return trimmed;
  return `"${trimmed.replace(/"/g, '""')}"`;
}
