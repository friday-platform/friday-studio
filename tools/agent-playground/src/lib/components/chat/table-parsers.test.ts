/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from "vitest";
import {
  parseDelimited,
  parseHTML,
  parseJSON,
  parseMarkdown,
  parseTabular,
  splitMarkdownByTables,
  TABULAR_MIMES,
} from "./table-parsers.ts";

describe("parseDelimited (CSV/TSV)", () => {
  it("parses a basic CSV with header + body", () => {
    const out = parseDelimited("id,name\n1,Alice\n2,Bob\n", ",");
    expect(out).toEqual({
      columns: ["id", "name"],
      rows: [
        ["1", "Alice"],
        ["2", "Bob"],
      ],
    });
  });

  it("respects quoted fields containing the separator", () => {
    const out = parseDelimited(`a,b\n1,"Seattle, WA"\n2,"Austin, TX"`, ",");
    expect(out?.rows).toEqual([
      ["1", "Seattle, WA"],
      ["2", "Austin, TX"],
    ]);
  });

  it("handles doubled-quote escape sequences inside a quoted cell", () => {
    const out = parseDelimited(`who,q\nAlice,"She said ""hi"""`, ",");
    expect(out?.rows[0]).toEqual(["Alice", `She said "hi"`]);
  });

  it("handles quoted cells containing literal newlines", () => {
    const out = parseDelimited(`a,b\n1,"line1\nline2"\n3,plain`, ",");
    expect(out?.rows).toEqual([
      ["1", "line1\nline2"],
      ["3", "plain"],
    ]);
  });

  it("handles TSV via tab separator", () => {
    const out = parseDelimited("a\tb\n1\tone\n2\ttwo", "\t");
    expect(out?.columns).toEqual(["a", "b"]);
    expect(out?.rows).toHaveLength(2);
  });

  it("returns null when the header has fewer than 2 cells", () => {
    expect(parseDelimited("singlecol\nrow1\nrow2", ",")).toBeNull();
  });

  it("returns null for an empty input", () => {
    expect(parseDelimited("", ",")).toBeNull();
  });

  it("skips blank lines so trailing newlines don't yield phantom rows", () => {
    const out = parseDelimited("a,b\n1,2\n\n\n", ",");
    expect(out?.rows).toEqual([["1", "2"]]);
  });

  it("treats classic-Mac \\r-only line endings as row breaks", () => {
    // Regression: prior version consumed \r and continued, expecting a
    // following \n. CR-only files (legacy macOS, some CSV exporters)
    // collapsed the whole document into one ragged row.
    const out = parseDelimited("a,b\r1,Alice\r2,Bob", ",");
    expect(out?.columns).toEqual(["a", "b"]);
    expect(out?.rows).toEqual([
      ["1", "Alice"],
      ["2", "Bob"],
    ]);
  });

  it("collapses \\r\\n to a single row break", () => {
    const out = parseDelimited("a,b\r\n1,Alice\r\n2,Bob\r\n", ",");
    expect(out?.rows).toEqual([
      ["1", "Alice"],
      ["2", "Bob"],
    ]);
  });
});

describe("parseJSON", () => {
  it("projects an array of objects with consistent keys", () => {
    const out = parseJSON(`[{"id":1,"name":"Alice"},{"id":2,"name":"Bob"}]`);
    expect(out).toEqual({
      columns: ["id", "name"],
      rows: [
        ["1", "Alice"],
        ["2", "Bob"],
      ],
    });
  });

  it("preserves first-occurrence column order and fills missing cells", () => {
    const out = parseJSON(
      `[{"a":1,"b":2},{"a":3,"b":4,"c":5}]`,
    );
    expect(out?.columns).toEqual(["a", "b", "c"]);
    expect(out?.rows).toEqual([
      ["1", "2", ""],
      ["3", "4", "5"],
    ]);
  });

  it("supports the explicit {columns, rows} shape", () => {
    const out = parseJSON(`{"columns":["x","y"],"rows":[[1,2],[3,4]]}`);
    expect(out).toEqual({ columns: ["x", "y"], rows: [["1", "2"], ["3", "4"]] });
  });

  it("returns null for non-tabular JSON", () => {
    expect(parseJSON("42")).toBeNull();
    expect(parseJSON("null")).toBeNull();
    expect(parseJSON("[]")).toBeNull();
    expect(parseJSON(`{"x":1}`)).toBeNull(); // single object, not an array
    expect(parseJSON(`[1, 2, 3]`)).toBeNull(); // array of primitives
  });

  it("returns null on parse error", () => {
    expect(parseJSON("not json")).toBeNull();
  });

  it("stringifies nested object/array cells", () => {
    const out = parseJSON(`[{"id":1,"meta":{"x":1}}]`);
    expect(out?.rows[0]?.[1]).toBe(`{"x":1}`);
  });
});

describe("parseHTML", () => {
  it("extracts the first <table> from an HTML document", () => {
    const out = parseHTML(`
      <html><body>
        <p>preamble</p>
        <table>
          <thead><tr><th>a</th><th>b</th></tr></thead>
          <tbody>
            <tr><td>1</td><td>Alice</td></tr>
            <tr><td>2</td><td>Bob</td></tr>
          </tbody>
        </table>
      </body></html>
    `);
    expect(out?.columns).toEqual(["a", "b"]);
    expect(out?.rows).toEqual([
      ["1", "Alice"],
      ["2", "Bob"],
    ]);
  });

  it("treats row 0 as header when no <th> is present", () => {
    const out = parseHTML(`<table>
      <tr><td>a</td><td>b</td></tr>
      <tr><td>1</td><td>2</td></tr>
    </table>`);
    expect(out?.columns).toEqual(["a", "b"]);
    expect(out?.rows).toEqual([["1", "2"]]);
  });

  it("returns null when no <table> is found", () => {
    expect(parseHTML("<html><body><p>no table</p></body></html>")).toBeNull();
  });

  it("collapses whitespace inside cell text", () => {
    const out = parseHTML(`<table>
      <tr><th>col</th></tr>
      <tr><td>  hello   world  </td></tr>
    </table>`);
    expect(out?.rows[0]?.[0]).toBe("hello world");
  });
});

describe("parseMarkdown", () => {
  it("extracts a markdown table block", () => {
    const md = [
      "# Heading",
      "",
      "Some prose.",
      "",
      "| id | name |",
      "| --- | --- |",
      "| 1 | Alice |",
      "| 2 | Bob |",
      "",
      "More prose.",
    ].join("\n");
    const out = parseMarkdown(md);
    expect(out?.columns).toEqual(["id", "name"]);
    expect(out?.rows).toEqual([
      ["1", "Alice"],
      ["2", "Bob"],
    ]);
  });

  it("honours escaped pipes in cell text", () => {
    const md = ["| a | b |", "| --- | --- |", "| x\\|y | z |"].join("\n");
    expect(parseMarkdown(md)?.rows[0]).toEqual(["x|y", "z"]);
  });

  it("accepts alignment cells (`:---`, `---:`, `:---:`)", () => {
    const md = ["| a | b | c |", "| :--- | :---: | ---: |", "| 1 | 2 | 3 |"].join("\n");
    expect(parseMarkdown(md)?.rows[0]).toEqual(["1", "2", "3"]);
  });

  it("returns null when no markdown table is present", () => {
    expect(parseMarkdown("# heading\n\nplain prose")).toBeNull();
  });

  it("currently matches pipe-shaped lines INSIDE fenced code blocks (limitation pin)", () => {
    // Pins current behavior: the parser is line-based and doesn't
    // track code-fence state. A markdown chat response that wraps a
    // table example in ``` will still be matched as a real table.
    // If/when we add fence tracking, this test should flip to assert
    // null and rename — until then the pin keeps a regression
    // observable rather than hidden inside agent output.
    const md = ["```", "| a | b |", "| --- | --- |", "| 1 | 2 |", "```"].join("\n");
    const out = parseMarkdown(md);
    expect(out?.columns).toEqual(["a", "b"]);
    expect(out?.rows).toEqual([["1", "2"]]);
  });

  it("stops body extraction at the first non-pipe line", () => {
    const md = [
      "| a | b |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      "| this | shouldn't | become | rows |",
    ].join("\n");
    expect(parseMarkdown(md)?.rows).toEqual([["1", "2"]]);
  });
});

describe("TABULAR_MIMES", () => {
  it("contains the four delimiter / structured formats", () => {
    expect(TABULAR_MIMES.has("text/csv")).toBe(true);
    expect(TABULAR_MIMES.has("text/tab-separated-values")).toBe(true);
    expect(TABULAR_MIMES.has("application/json")).toBe(true);
    expect(TABULAR_MIMES.has("text/html")).toBe(true);
  });

  it("excludes text/markdown — markdown routes to the dedicated /markdown viewer", () => {
    expect(TABULAR_MIMES.has("text/markdown")).toBe(false);
  });
});

describe("splitMarkdownByTables", () => {
  it("returns a single prose segment when no tables are present", () => {
    const segs = splitMarkdownByTables("# Whitepaper\n\nJust prose here.");
    expect(segs).toHaveLength(1);
    expect(segs[0]).toEqual({
      kind: "prose",
      markdown: "# Whitepaper\n\nJust prose here.",
    });
  });

  it("splits a document with one embedded table into [prose, table, prose]", () => {
    const md = [
      "# Report",
      "",
      "Intro paragraph.",
      "",
      "| a | b |",
      "| --- | --- |",
      "| 1 | 2 |",
      "| 3 | 4 |",
      "",
      "Closing thoughts.",
    ].join("\n");
    const segs = splitMarkdownByTables(md);
    expect(segs).toHaveLength(3);
    expect(segs[0]?.kind).toBe("prose");
    expect(segs[1]).toEqual({
      kind: "table",
      model: {
        columns: ["a", "b"],
        rows: [
          ["1", "2"],
          ["3", "4"],
        ],
      },
    });
    expect(segs[2]).toEqual({ kind: "prose", markdown: "\nClosing thoughts." });
  });

  it("captures multiple tables in document order", () => {
    const md = [
      "Before.",
      "",
      "| a | b |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      "Middle.",
      "",
      "| x | y |",
      "| --- | --- |",
      "| 9 | 8 |",
      "",
      "After.",
    ].join("\n");
    const segs = splitMarkdownByTables(md);
    const tables = segs.filter((s) => s.kind === "table");
    expect(tables).toHaveLength(2);
    expect(tables[0]?.kind === "table" && tables[0].model.columns).toEqual(["a", "b"]);
    expect(tables[1]?.kind === "table" && tables[1].model.columns).toEqual(["x", "y"]);
  });

  it("does not emit empty prose segments around back-to-back tables", () => {
    const md = [
      "| a | b |",
      "| --- | --- |",
      "| 1 | 2 |",
      "| x | y |",
      "| --- | --- |",
      "| 9 | 8 |",
    ].join("\n");
    // Two tables in a row collapse into the second's continuation rows under
    // the lenient parser — that's a separate corner. Here we just assert that
    // the result doesn't include any whitespace-only prose entries.
    const segs = splitMarkdownByTables(md);
    for (const s of segs) {
      if (s.kind === "prose") {
        expect(s.markdown.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("returns a single prose segment when the only 'table' has a single column header", () => {
    const md = ["| only |", "| --- |", "| value |"].join("\n");
    const segs = splitMarkdownByTables(md);
    expect(segs.every((s) => s.kind === "prose")).toBe(true);
  });
});

describe("parseTabular (dispatcher)", () => {
  it("dispatches by mimeType prefix and ignores charset params", () => {
    const out = parseTabular("text/csv; charset=utf-8", "a,b\n1,2");
    expect(out?.columns).toEqual(["a", "b"]);
  });

  it("returns null for unsupported mime types", () => {
    expect(parseTabular("image/png", "ignored")).toBeNull();
    expect(parseTabular("application/pdf", "ignored")).toBeNull();
  });

  it("normalizes mime-type casing before dispatch", () => {
    // `Text/CSV` and ` text/csv ` should both route to parseDelimited.
    expect(parseTabular("Text/CSV", "a,b\n1,2")).toEqual({
      columns: ["a", "b"],
      rows: [["1", "2"]],
    });
    expect(parseTabular(" text/csv ", "a,b\n1,2")).toEqual({
      columns: ["a", "b"],
      rows: [["1", "2"]],
    });
  });
});
