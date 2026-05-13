/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from "vitest";
import { tableToSafeHTML } from "./table-to-html.ts";

function makeTable(html: string): HTMLTableElement {
  const div = document.createElement("div");
  div.innerHTML = html;
  const table = div.querySelector("table");
  if (!table) throw new Error("test fixture missing <table>");
  return table as HTMLTableElement;
}

describe("tableToSafeHTML", () => {
  it("emits a well-formed thead + tbody when both rows exist", () => {
    const t = makeTable(`
      <table>
        <thead><tr><th>id</th><th>name</th></tr></thead>
        <tbody>
          <tr><td>1</td><td>Alice</td></tr>
        </tbody>
      </table>
    `);
    expect(tableToSafeHTML(t)).toBe(
      "<table>" +
        "<thead><tr><th>id</th><th>name</th></tr></thead>" +
        "<tbody><tr><td>1</td><td>Alice</td></tr></tbody>" +
        "</table>",
    );
  });

  it("drops live <script> tags from cell content (script body becomes text)", () => {
    // The whole point: an artifact containing `<table><script>...`
    // must NOT round-trip a live `<script>` element into the clipboard
    // payload. The script's text body is allowed to land inside the
    // <td> as escaped text — destinations that render the HTML see
    // literal "alert(1)" letters in a cell, not a runnable script.
    const t = makeTable(`
      <table>
        <tr><th>safe</th></tr>
        <tr><td>value<script>alert(1)</script></td></tr>
      </table>
    `);
    const out = tableToSafeHTML(t);
    expect(out).not.toContain("<script");
    expect(out).not.toContain("</script>");
    // Cell text includes "value" + the script body as inert text.
    expect(out).toContain("<td>valuealert(1)</td>");
  });

  it("strips inline formatting like <strong>/<em>/<a>", () => {
    const t = makeTable(`
      <table>
        <tr><th>col</th></tr>
        <tr><td><strong>bold</strong> and <a href="javascript:bad">link</a></td></tr>
      </table>
    `);
    const out = tableToSafeHTML(t);
    expect(out).not.toContain("<strong>");
    expect(out).not.toContain("<a ");
    expect(out).not.toContain("javascript:");
    expect(out).toContain("<td>bold and link</td>");
  });

  it("ignores cell attributes (onClick, style, data-*)", () => {
    const t = makeTable(`
      <table>
        <tr><td onclick="evil()" style="color:red" data-x="1">x</td></tr>
      </table>
    `);
    const out = tableToSafeHTML(t);
    expect(out).not.toContain("onclick");
    expect(out).not.toContain("style");
    expect(out).not.toContain("data-x");
  });

  it("HTML-escapes the five entity-sensitive characters inside cells", () => {
    const t = document.createElement("table");
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.textContent = `< & > " '`;
    tr.appendChild(td);
    t.appendChild(tr);
    expect(tableToSafeHTML(t)).toContain("<td>&lt; &amp; &gt; &quot; &#39;</td>");
  });

  it("opens a <tbody> even when no header row is present", () => {
    const t = makeTable(`
      <table>
        <tr><td>1</td><td>Alice</td></tr>
      </table>
    `);
    expect(tableToSafeHTML(t)).toBe(
      "<table><tbody><tr><td>1</td><td>Alice</td></tr></tbody></table>",
    );
  });
});
