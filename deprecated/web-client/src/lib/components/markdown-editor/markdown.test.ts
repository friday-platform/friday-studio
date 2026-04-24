import { describe, expect, it } from "vitest";
import { parseMarkdown, serializeMarkdown } from "./markdown.ts";
import { editorSchema } from "./schema.ts";

function roundtrip(md: string): string {
  const doc = parseMarkdown(md);
  return serializeMarkdown(doc);
}

describe("markdown roundtrip", () => {
  it("handles paragraphs", () => {
    const md = "Hello world";
    expect(roundtrip(md)).toBe("Hello world");
  });

  it("handles heading 1", () => {
    expect(roundtrip("# Heading")).toBe("# Heading");
  });

  it("handles heading 2", () => {
    expect(roundtrip("## Heading")).toBe("## Heading");
  });

  it("handles heading 3", () => {
    expect(roundtrip("### Heading")).toBe("### Heading");
  });

  it("handles bold text", () => {
    expect(roundtrip("This is **bold** text")).toBe("This is **bold** text");
  });

  it("handles italic text", () => {
    expect(roundtrip("This is *italic* text")).toBe("This is *italic* text");
  });

  it("handles inline code", () => {
    expect(roundtrip("Use `code` here")).toBe("Use `code` here");
  });

  it("handles mixed inline marks", () => {
    const md = "Some **bold** and *italic* and `code` text";
    expect(roundtrip(md)).toBe(md);
  });

  it("handles blockquotes", () => {
    expect(roundtrip("> A quote")).toBe("> A quote");
  });

  it("handles fenced code blocks", () => {
    const md = "```js\nconst x = 1;\n```";
    expect(roundtrip(md)).toBe(md);
  });

  it("handles code blocks without language", () => {
    const md = "```\nplain code\n```";
    expect(roundtrip(md)).toBe(md);
  });

  it("handles bullet lists", () => {
    const md = "- one\n\n- two\n\n- three";
    const result = roundtrip(md);
    expect(result).toContain("- one");
    expect(result).toContain("- two");
    expect(result).toContain("- three");
  });

  it("handles ordered lists", () => {
    const md = "1. first\n\n2. second\n\n3. third";
    const result = roundtrip(md);
    expect(result).toContain("1. first");
    expect(result).toContain("2. second");
    expect(result).toContain("3. third");
  });

  it("handles nested lists", () => {
    const md = "- parent\n\n  - child";
    const result = roundtrip(md);
    expect(result).toContain("- parent");
    expect(result).toContain("child");
  });

  it("handles GFM tables", () => {
    const md = "| Name | Age |\n| --- | --- |\n| Alice | 30 |";
    const result = roundtrip(md);
    expect(result).toContain("| Name");
    expect(result).toContain("| Age");
    expect(result).toContain("---");
    expect(result).toContain("| Alice");
    expect(result).toContain("| 30");
  });

  it("handles multiple paragraphs", () => {
    const md = "First paragraph\n\nSecond paragraph";
    expect(roundtrip(md)).toBe(md);
  });

  it("ignores images gracefully", () => {
    const md = "Before\n\n![alt](http://example.com/img.png)\n\nAfter";
    const result = roundtrip(md);
    expect(result).toContain("Before");
    expect(result).toContain("After");
  });

  it("preserves links", () => {
    const md = "Click [here](http://example.com) now";
    const result = roundtrip(md);
    expect(result).toContain("[here](http://example.com)");
  });

  it("roundtrips horizontal rules", () => {
    const md = "Before\n\n---\n\nAfter";
    const result = roundtrip(md);
    expect(result).toContain("Before");
    expect(result).toContain("---");
    expect(result).toContain("After");
  });

  it("roundtrips two paragraphs separated by Enter", () => {
    const doc = editorSchema.node("doc", null, [
      editorSchema.node("paragraph", null, [editorSchema.text("paragraph one")]),
      editorSchema.node("paragraph", null, [editorSchema.text("paragraph two")]),
    ]);
    const md = serializeMarkdown(doc);
    expect(md).toBe("paragraph one\n\nparagraph two");
    expect(serializeMarkdown(parseMarkdown(md))).toBe(md);
  });

  it("roundtrips empty paragraphs between content", () => {
    const doc = editorSchema.node("doc", null, [
      editorSchema.node("paragraph", null, [editorSchema.text("paragraph one")]),
      editorSchema.node("paragraph"),
      editorSchema.node("paragraph"),
      editorSchema.node("paragraph", null, [editorSchema.text("paragraph two")]),
    ]);
    const md = serializeMarkdown(doc);
    // Empty paragraphs serialize as ZWS markers
    expect(md).toContain("\u200B");
    // Roundtrip preserves the empty paragraphs
    const parsed = parseMarkdown(md);
    expect(serializeMarkdown(parsed)).toBe(md);
  });

  it("roundtrips shift+enter hard breaks", () => {
    const doc = editorSchema.node("doc", null, [
      editorSchema.node("paragraph", null, [
        editorSchema.text("paragraph one"),
        editorSchema.node("hard_break"),
        editorSchema.node("hard_break"),
        editorSchema.node("hard_break"),
        editorSchema.text("paragraph two"),
      ]),
    ]);
    const md = serializeMarkdown(doc);
    expect(md).toBe("paragraph one\\\n\\\n\\\nparagraph two");
    expect(serializeMarkdown(parseMarkdown(md))).toBe(md);
  });

  it("preserves hard breaks in paragraphs", () => {
    const para = editorSchema.node("paragraph", null, [
      editorSchema.text("paragraph one"),
      editorSchema.node("hard_break"),
      editorSchema.text("paragraph two"),
    ]);
    const doc = editorSchema.node("doc", null, [para]);
    const md = serializeMarkdown(doc);
    expect(md).toBe("paragraph one\\\nparagraph two");
    // roundtrip
    const parsed = parseMarkdown(md);
    expect(serializeMarkdown(parsed)).toBe(md);
  });

  it("preserves multiple hard breaks in paragraphs", () => {
    const para = editorSchema.node("paragraph", null, [
      editorSchema.text("paragraph one"),
      editorSchema.node("hard_break"),
      editorSchema.node("hard_break"),
      editorSchema.node("hard_break"),
      editorSchema.text("paragraph two"),
    ]);
    const doc = editorSchema.node("doc", null, [para]);
    const md = serializeMarkdown(doc);
    expect(md).toBe("paragraph one\\\n\\\n\\\nparagraph two");
    // roundtrip
    const parsed = parseMarkdown(md);
    expect(serializeMarkdown(parsed)).toBe(md);
  });

  it("strips trailing hard breaks from paragraphs", () => {
    const doc = editorSchema.node("doc", null, [
      editorSchema.node("paragraph", null, [
        editorSchema.text("some text"),
        editorSchema.node("hard_break"),
        editorSchema.node("hard_break"),
      ]),
    ]);
    const md = serializeMarkdown(doc);
    // Trailing hard breaks are stripped — they can't roundtrip through markdown
    expect(md).toBe("some text");
    expect(serializeMarkdown(parseMarkdown(md))).toBe(md);
  });

  it("strips trailing hard breaks but preserves mid-content ones", () => {
    const doc = editorSchema.node("doc", null, [
      editorSchema.node("paragraph", null, [
        editorSchema.text("line one"),
        editorSchema.node("hard_break"),
        editorSchema.text("line two"),
        editorSchema.node("hard_break"),
        editorSchema.node("hard_break"),
      ]),
    ]);
    const md = serializeMarkdown(doc);
    expect(md).toBe("line one\\\nline two");
    expect(serializeMarkdown(parseMarkdown(md))).toBe(md);
  });

  it("collapses hard breaks in headings to spaces", () => {
    const heading = editorSchema.node("heading", { level: 2 }, [
      editorSchema.text("Testing"),
      editorSchema.node("hard_break"),
      editorSchema.text("this out"),
    ]);
    const doc = editorSchema.node("doc", null, [heading]);
    const md = serializeMarkdown(doc);
    expect(md).toBe("## Testing this out");
  });

  it("handles mixed content", () => {
    const md = [
      "# Title",
      "",
      "A paragraph with **bold** and *italic*.",
      "",
      "> A blockquote",
      "",
      "- item one",
      "",
      "- item two",
      "",
      "```ts",
      "const x = 1;",
      "```",
    ].join("\n");
    const result = roundtrip(md);
    expect(result).toContain("# Title");
    expect(result).toContain("**bold**");
    expect(result).toContain("*italic*");
    expect(result).toContain("> A blockquote");
    expect(result).toContain("- item one");
    expect(result).toContain("const x = 1;");
  });
});
