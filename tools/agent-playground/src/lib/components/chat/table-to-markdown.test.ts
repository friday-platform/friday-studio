/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from "vitest";
import { tableToMarkdown } from "./table-to-markdown.ts";

function makeTable(html: string): HTMLTableElement {
  const div = document.createElement("div");
  div.innerHTML = html;
  const table = div.querySelector("table");
  if (!table) throw new Error("test fixture missing <table>");
  return table as HTMLTableElement;
}

describe("tableToMarkdown", () => {
  it("emits a header + separator + body rows", () => {
    const t = makeTable(`
      <table>
        <thead><tr><th>id</th><th>name</th></tr></thead>
        <tbody>
          <tr><td>1</td><td>Alice</td></tr>
          <tr><td>2</td><td>Bob</td></tr>
        </tbody>
      </table>
    `);
    expect(tableToMarkdown(t)).toBe(
      ["| id | name |", "| --- | --- |", "| 1 | Alice |", "| 2 | Bob |"].join("\n"),
    );
  });

  it("synthesizes a header separator from the first row when no <th> is present", () => {
    // Some markdown renderers emit `<table><tr><td>` without a thead.
    // The serialized markdown still needs a separator line for the
    // result to render as a table downstream.
    const t = makeTable(`
      <table>
        <tr><td>1</td><td>Alice</td></tr>
        <tr><td>2</td><td>Bob</td></tr>
      </table>
    `);
    expect(tableToMarkdown(t)).toBe(
      ["| 1 | Alice |", "| --- | --- |", "| 2 | Bob |"].join("\n"),
    );
  });

  it("escapes literal pipes inside cell text", () => {
    const t = makeTable(`
      <table>
        <tr><th>a</th><th>b</th></tr>
        <tr><td>x|y</td><td>plain</td></tr>
      </table>
    `);
    expect(tableToMarkdown(t)).toContain("| x\\|y | plain |");
  });

  it("collapses internal whitespace and newlines inside cells", () => {
    const t = makeTable(`
      <table>
        <tr><th>col</th></tr>
        <tr><td>one
              two   three</td></tr>
      </table>
    `);
    expect(tableToMarkdown(t)).toContain("| one two three |");
  });

  it("pads ragged rows so the markdown is well-formed", () => {
    const t = makeTable(`
      <table>
        <tr><th>a</th><th>b</th><th>c</th></tr>
        <tr><td>1</td><td>2</td></tr>
      </table>
    `);
    expect(tableToMarkdown(t)).toBe(
      ["| a | b | c |", "| --- | --- | --- |", "| 1 | 2 |  |"].join("\n"),
    );
  });

  it("returns the empty string for a zero-row table", () => {
    const t = makeTable(`<table></table>`);
    expect(tableToMarkdown(t)).toBe("");
  });
});
