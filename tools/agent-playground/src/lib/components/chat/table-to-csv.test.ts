/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from "vitest";
import { tableToCSV } from "./table-to-csv.ts";

function makeTable(html: string): HTMLTableElement {
  const div = document.createElement("div");
  div.innerHTML = html;
  const table = div.querySelector("table");
  if (!table) throw new Error("test fixture missing <table>");
  return table as HTMLTableElement;
}

describe("tableToCSV", () => {
  it("emits a basic header + body without quoting safe cells", () => {
    const t = makeTable(`
      <table>
        <thead><tr><th>id</th><th>name</th></tr></thead>
        <tbody>
          <tr><td>1</td><td>Alice</td></tr>
          <tr><td>2</td><td>Bob</td></tr>
        </tbody>
      </table>
    `);
    expect(tableToCSV(t)).toBe(["id,name", "1,Alice", "2,Bob"].join("\r\n"));
  });

  it("quotes cells containing a comma", () => {
    const t = makeTable(`
      <table>
        <tr><th>name</th><th>city</th></tr>
        <tr><td>Alice</td><td>Seattle, WA</td></tr>
      </table>
    `);
    expect(tableToCSV(t)).toBe(["name,city", `Alice,"Seattle, WA"`].join("\r\n"));
  });

  it("doubles internal double-quotes per RFC-4180", () => {
    const t = makeTable(`
      <table>
        <tr><th>quote</th></tr>
        <tr><td>She said "hi"</td></tr>
      </table>
    `);
    expect(tableToCSV(t)).toBe(["quote", `"She said ""hi"""`].join("\r\n"));
  });

  it("quotes cells containing a newline", () => {
    // happy-dom preserves the literal \n inside td text content.
    const t = document.createElement("table");
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.textContent = "line1\nline2";
    tr.appendChild(td);
    t.appendChild(tr);
    // Newline is preserved inside the quoted field — RFC-4180 allows
    // it and Excel parses it as a single cell with a line break.
    expect(tableToCSV(t)).toBe(`"line1\nline2"`);
  });

  it("returns the empty string for a zero-row table", () => {
    const t = makeTable(`<table></table>`);
    expect(tableToCSV(t)).toBe("");
  });

  it("trims whitespace around cell content (matches markdown serializer)", () => {
    const t = makeTable(`
      <table>
        <tr><th>  spacey  </th></tr>
        <tr><td>   value   </td></tr>
      </table>
    `);
    expect(tableToCSV(t)).toBe(["spacey", "value"].join("\r\n"));
  });
});
