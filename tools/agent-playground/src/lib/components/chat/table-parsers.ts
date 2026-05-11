/**
 * Parse a tabular artifact's content into the `{columns, rows}` model
 * the TableView component consumes. Branches on the artifact's
 * Content-Type so the same code path handles CSV uploads, JSON arrays,
 * markdown tables, and HTML tables that originated from chat tools.
 *
 * The parsers are intentionally lenient — these inputs come from
 * heterogeneous tool outputs across the MCP ecosystem and we'd rather
 * render a slightly-imperfect table than refuse. Validation/strictness
 * belongs in the producer side, not here.
 */

export interface TableModel {
  /** Column header labels. Length matches each row's expected width. */
  columns: string[];
  /** Row data — each row is a parallel array of cell strings. */
  rows: string[][];
}

/**
 * Mime types this parser knows how to project into a TableModel.
 * Exported for the artifact-route dispatcher's "is this tabular?"
 * decision so both surfaces agree on the answer without duplicating
 * the list. Add a new branch to `parseTabular` AND this set in lock-
 * step; a mime in the set with no `parseTabular` case is a runtime
 * promise we can't keep.
 *
 * `text/markdown` is intentionally absent: markdown artifacts route to
 * the dedicated `/markdown` viewer, which renders the document as prose
 * and surfaces any embedded tables inline via TableView + the action
 * bar. `parseMarkdown` (below) is still kept and used by the inline
 * snapshot path that produces a single-table TableModel from a
 * pipe-only markdown blob.
 */
export const TABULAR_MIMES: ReadonlySet<string> = new Set([
  "text/csv",
  "text/tab-separated-values",
  "application/json",
  "text/html",
]);

/**
 * Pick the right parser for a mimeType + raw text payload and return
 * `null` when the content isn't recognizably tabular. Callers branch on
 * `null` to fall back to a generic file viewer.
 *
 * Strips any `; charset=...` parameter before matching.
 */
export function parseTabular(mimeType: string, text: string): TableModel | null {
  // Only the canonical mimes the scrubber actually emits. Speculative
  // aliases (text/tsv, text/json, application/xhtml+xml,
  // text/x-markdown) were dropped — re-add with a test when a real
  // producer surfaces them.
  const base = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  switch (base) {
    case "text/csv":
      return parseDelimited(text, ",");
    case "text/tab-separated-values":
      return parseDelimited(text, "\t");
    case "application/json":
      return parseJSON(text);
    case "text/html":
      return parseHTML(text);
    case "text/markdown":
      return parseMarkdown(text);
    default:
      return null;
  }
}

/**
 * Parse RFC-4180-ish CSV/TSV. Handles quoted fields (with embedded
 * separators, quotes, and newlines) and doubled-quote escaping.
 * First non-empty row becomes the header. Returns `null` when there
 * aren't at least 2 cells in the header (a single-column "table" is
 * really just a list).
 */
export function parseDelimited(text: string, sep: "," | "\t"): TableModel | null {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i] ?? "";
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === sep) {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\r") {
      // Three cases:
      //   \r\n  → row break (Windows / RFC-4180). Consume both as one.
      //   \r    → row break (classic Mac, some CSV tools). Consume one.
      //   \r"…  inside a quoted field is handled by the `inQuotes` branch
      //         above, not here.
      // Skipping `\r` without pushing was the prior bug — CR-only files
      // collapsed the whole document into a single ragged row.
      row.push(field);
      field = "";
      if (row.some((c) => c.length > 0)) rows.push(row);
      row = [];
      i++;
      if (text[i] === "\n") i++; // swallow paired \n in \r\n
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      field = "";
      // Skip blank lines so trailing newlines don't introduce phantom rows.
      if (row.some((c) => c.length > 0)) rows.push(row);
      row = [];
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  // Flush trailing field + row.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.some((c) => c.length > 0)) rows.push(row);
  }

  if (rows.length === 0) return null;
  const header = rows[0];
  if (!header || header.length < 2) return null;
  return { columns: header.map((c) => c.trim()), rows: rows.slice(1) };
}

/**
 * Parse a JSON document. Two supported shapes:
 *   1. Array of objects with consistent keys — the union of every
 *      object's keys becomes the column set; missing keys render as
 *      empty cells. Columns are ordered by first-occurrence so the
 *      first object's keys lead.
 *   2. `{columns: string[], rows: any[][]}` — explicit shape some
 *      data-export tools emit.
 * Anything else (primitive, scalar JSON, single object, mixed array)
 * is not tabular — returns `null`.
 */
export function parseJSON(text: string): TableModel | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  // Explicit {columns, rows} shape.
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    Array.isArray((parsed as { columns?: unknown }).columns) &&
    Array.isArray((parsed as { rows?: unknown }).rows)
  ) {
    const obj = parsed as { columns: unknown[]; rows: unknown[] };
    const columns = obj.columns.map((c) => stringify(c));
    const rows = obj.rows
      .filter((r): r is unknown[] => Array.isArray(r))
      .map((r) => r.map((c) => stringify(c)));
    return { columns, rows };
  }
  // Array of objects.
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const looksTabular = parsed.every(
    (item) => typeof item === "object" && item !== null && !Array.isArray(item),
  );
  if (!looksTabular) return null;
  const objects = parsed as Array<Record<string, unknown>>;
  // Column order: first object's keys first, then any keys that appear
  // later but weren't in the first object (preserves the natural shape
  // for the common all-rows-same-keys case while still surfacing late
  // additions).
  const columnOrder: string[] = [];
  const columnSet = new Set<string>();
  for (const obj of objects) {
    for (const k of Object.keys(obj)) {
      if (!columnSet.has(k)) {
        columnSet.add(k);
        columnOrder.push(k);
      }
    }
  }
  if (columnOrder.length === 0) return null;
  const rows = objects.map((obj) => columnOrder.map((k) => stringify(obj[k])));
  return { columns: columnOrder, rows };
}

/**
 * Find the first `<table>` in an HTML document and project it. We pick
 * the first table to keep the route's "one artifact, one table view"
 * contract simple; multi-table artifacts can be handled later if the
 * usage shows up. The DOM is built in a detached document fragment so
 * we don't touch the live page.
 *
 * Browser-only — runs in the SvelteKit `+page.svelte`'s `<script>`,
 * never on the server, so `DOMParser` is always available.
 */
export function parseHTML(html: string): TableModel | null {
  if (typeof DOMParser === "undefined") return null;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const table = doc.querySelector("table");
  if (!table) return null;
  return projectDOMTable(table);
}

/**
 * Find the first markdown table in a document. Re-renders the markdown
 * to HTML and reuses the HTML extractor — keeps a single source of
 * truth for cell extraction, and inherits any inline-formatting
 * stripping the HTML branch does naturally via `textContent`.
 */
export function parseMarkdown(md: string): TableModel | null {
  if (typeof DOMParser === "undefined") return null;
  // Cheap parser: extract just the markdown table block ourselves so
  // we don't pull a full markdown lib for this one use. Look for the
  // `| --- | --- |` separator line; the line above is the header, the
  // lines below are body, until a non-pipe line or EOF.
  const lines = md.split("\n");
  let headerIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (isSeparatorLine(lines[i] ?? "") && isPipeLine(lines[i - 1] ?? "")) {
      headerIdx = i - 1;
      break;
    }
  }
  if (headerIdx === -1) return null;
  const header = splitPipeRow(lines[headerIdx] ?? "");
  const rows: string[][] = [];
  for (let i = headerIdx + 2; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!isPipeLine(line)) break;
    rows.push(splitPipeRow(line));
  }
  if (header.length < 2) return null;
  return { columns: header, rows };
}

// -- internals ------------------------------------------------------

function projectDOMTable(table: Element): TableModel {
  const rows: string[][] = [];
  for (const tr of table.querySelectorAll("tr")) {
    const cells: string[] = [];
    for (const cell of tr.querySelectorAll("th, td")) {
      cells.push(((cell as HTMLElement).textContent ?? "").trim().replace(/\s+/g, " "));
    }
    if (cells.length > 0) rows.push(cells);
  }
  if (rows.length === 0) return { columns: [], rows: [] };
  // Use the first <th>-bearing row as header if any row has them.
  let headerIdx = 0;
  let hasHeader = false;
  const trs = Array.from(table.querySelectorAll("tr"));
  for (let i = 0; i < trs.length; i++) {
    if (trs[i]?.querySelector("th")) {
      headerIdx = i;
      hasHeader = true;
      break;
    }
  }
  if (!hasHeader) {
    // No <th> anywhere — treat row 0 as header anyway so the view has
    // a labelled top edge. Matches the markdown serializer's behavior.
    const header = rows[0] ?? [];
    return { columns: header, rows: rows.slice(1) };
  }
  const header = rows[headerIdx] ?? [];
  return {
    columns: header,
    rows: rows.filter((_, idx) => idx !== headerIdx),
  };
}

/**
 * Discriminated segment used by the markdown viewer: a markdown document
 * is rendered as an alternating sequence of `prose` and `table` segments.
 * Prose chunks are handed to `markdownToHTMLSafe`; table chunks render
 * via `TableView` so the same chrome that powers `/artifacts/.../table`
 * applies to tables embedded inside a whitepaper.
 */
export type MarkdownSegment =
  | { kind: "prose"; markdown: string }
  | { kind: "table"; model: TableModel };

/**
 * Walk `md` line-by-line, slicing out every pipe-table block (detected by
 * the same heuristic `parseMarkdown` uses — header line followed by a
 * `| --- | --- |` separator) and returning the alternating sequence of
 * prose and table segments. Empty leading/trailing prose chunks are
 * elided.
 */
export function splitMarkdownByTables(md: string): MarkdownSegment[] {
  const lines = md.split("\n");
  const segments: MarkdownSegment[] = [];
  let prose: string[] = [];

  const flushProse = () => {
    if (prose.length === 0) return;
    const text = prose.join("\n");
    // Skip if it's only whitespace — keeps the rendered output tight
    // when a table sits between two blank lines.
    if (text.trim().length > 0) {
      segments.push({ kind: "prose", markdown: text });
    }
    prose = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const headerLine = lines[i] ?? "";
    const sepLine = lines[i + 1] ?? "";
    if (i + 1 < lines.length && isPipeLine(headerLine) && isSeparatorLine(sepLine)) {
      // Found a table starting at `i`. Collect body until non-pipe / EOF.
      flushProse();
      const header = splitPipeRow(headerLine);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && isPipeLine(lines[j] ?? "")) {
        rows.push(splitPipeRow(lines[j] ?? ""));
        j++;
      }
      if (header.length >= 2) {
        segments.push({ kind: "table", model: { columns: header, rows } });
      } else {
        // Header too narrow to be a real table — fall through, keep
        // the original lines as prose. Treat both `headerLine` and the
        // collected rows as raw text.
        prose.push(headerLine, sepLine);
        for (let k = i + 2; k < j; k++) prose.push(lines[k] ?? "");
      }
      i = j - 1;
      continue;
    }
    prose.push(headerLine);
  }

  flushProse();
  return segments;
}

function isPipeLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith("|") && t.endsWith("|") && t.length >= 3;
}

function isSeparatorLine(line: string): boolean {
  const t = line.trim();
  if (!isPipeLine(t)) return false;
  // Each segment between pipes must be made up of `-`, `:`, and whitespace.
  const cells = t.slice(1, -1).split("|");
  if (cells.length === 0) return false;
  return cells.every((c) => /^\s*:?-+:?\s*$/.test(c));
}

function splitPipeRow(line: string): string[] {
  const t = line.trim();
  // Strip leading and trailing pipe, then split on unescaped `|`.
  const inner = t.startsWith("|") ? t.slice(1) : t;
  const stripped = inner.endsWith("|") ? inner.slice(0, -1) : inner;
  // Honour `\|` as an escaped literal pipe — the markdown serializer
  // emits this when cell text contains a pipe.
  const cells: string[] = [];
  let buf = "";
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (ch === "\\" && stripped[i + 1] === "|") {
      buf += "|";
      i++;
      continue;
    }
    if (ch === "|") {
      cells.push(buf.trim());
      buf = "";
      continue;
    }
    buf += ch ?? "";
  }
  cells.push(buf.trim());
  return cells;
}

function stringify(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  // Objects/arrays inside a cell — JSON-encode rather than render
  // `[object Object]`. The user can see the raw shape and decide
  // whether to drill in.
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
