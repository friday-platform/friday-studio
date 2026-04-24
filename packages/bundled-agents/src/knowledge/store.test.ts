import { describe, expect, test } from "vitest";
import { detectColumns, parseCsvRow, stripHtml } from "./store.ts";

describe("parseCsvRow", () => {
  test("splits simple comma-separated values", () => {
    expect(parseCsvRow("a,b,c")).toEqual(["a", "b", "c"]);
  });

  test("handles quoted fields", () => {
    expect(parseCsvRow('"hello","world"')).toEqual(["hello", "world"]);
  });

  test("handles commas inside quoted fields", () => {
    expect(parseCsvRow('"hello, world",foo')).toEqual(["hello, world", "foo"]);
  });

  test("handles escaped double quotes inside quoted fields", () => {
    expect(parseCsvRow('"say ""hello""",bar')).toEqual(['say "hello"', "bar"]);
  });

  test("handles empty fields", () => {
    expect(parseCsvRow("a,,c")).toEqual(["a", "", "c"]);
  });

  test("handles single field", () => {
    expect(parseCsvRow("hello")).toEqual(["hello"]);
  });

  test("handles empty string", () => {
    expect(parseCsvRow("")).toEqual([""]);
  });

  test("handles mixed quoted and unquoted", () => {
    expect(parseCsvRow('foo,"bar, baz",qux')).toEqual(["foo", "bar, baz", "qux"]);
  });

  test("handles trailing comma", () => {
    expect(parseCsvRow("a,b,")).toEqual(["a", "b", ""]);
  });
});

describe("stripHtml", () => {
  test("removes HTML tags", () => {
    expect(stripHtml("<p>Hello <b>world</b></p>")).toBe("Hello world");
  });

  test("converts <br> to newline", () => {
    expect(stripHtml("line1<br>line2")).toBe("line1\nline2");
  });

  test("converts <br/> and <br /> to newline", () => {
    expect(stripHtml("line1<br/>line2<br />line3")).toBe("line1\nline2\nline3");
  });

  test("converts </p> to double newline", () => {
    expect(stripHtml("<p>para1</p><p>para2</p>")).toBe("para1\n\npara2");
  });

  test("decodes HTML entities", () => {
    expect(stripHtml("&amp; &lt; &gt; &quot;")).toBe('& < > "');
    expect(stripHtml("&nbsp;")).toBe("");
  });

  test("collapses excessive newlines", () => {
    expect(stripHtml("<p>a</p><p></p><p></p><p>b</p>")).toBe("a\n\nb");
  });

  test("trims whitespace", () => {
    expect(stripHtml("  <p>hello</p>  ")).toBe("hello");
  });

  test("handles empty string", () => {
    expect(stripHtml("")).toBe("");
  });

  test("handles plain text without HTML", () => {
    expect(stripHtml("no tags here")).toBe("no tags here");
  });
});

describe("detectColumns", () => {
  test("detects Bucketlist KB article columns", () => {
    const headers = [
      "Knowledge base name",
      "Article title",
      "Article subtitle",
      "Article language",
      "Article URL",
      "Article body",
      "Category",
      "Subcategory",
    ];
    const mapping = detectColumns(headers);
    expect(mapping.title).toBe("Article title");
    expect(mapping.content).toBe("Article body");
    expect(mapping.url).toBe("Article URL");
    expect(mapping.sourceType).toBe("knowledge_base");
  });

  test("detects ticket columns", () => {
    const headers = ["Ticket ID", "Ticket name", "Ticket description", "Ticket status"];
    const mapping = detectColumns(headers);
    expect(mapping.title).toBe("Ticket name");
    expect(mapping.content).toBe("Ticket description");
    expect(mapping.idColumn).toBe("Ticket ID");
    expect(mapping.sourceType).toBe("ticket");
  });

  test("detects generic columns", () => {
    const headers = ["title", "body", "url"];
    const mapping = detectColumns(headers);
    expect(mapping.title).toBe("title");
    expect(mapping.content).toBe("body");
    expect(mapping.url).toBe("url");
    expect(mapping.sourceType).toBe("document");
  });

  test("returns null for unrecognized columns", () => {
    const headers = ["foo", "bar", "baz"];
    const mapping = detectColumns(headers);
    expect(mapping.title).toBeNull();
    expect(mapping.content).toBeNull();
    expect(mapping.url).toBeNull();
  });

  test("detects response/resolution column", () => {
    const headers = ["subject", "description", "resolution"];
    const mapping = detectColumns(headers);
    expect(mapping.response).toBe("resolution");
  });

  test("detects category column", () => {
    const headers = ["title", "content", "category"];
    const mapping = detectColumns(headers);
    expect(mapping.categoryColumn).toBe("category");
  });

  test("detects confluence source type", () => {
    const headers = ["confluence page", "content"];
    const mapping = detectColumns(headers);
    expect(mapping.sourceType).toBe("confluence");
  });
});
