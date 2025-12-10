import { assertEquals, assertExists } from "@std/assert";
import {
  astToHTML,
  cleanMarkdownSyntax,
  extractLinkData,
  markdownToHTML,
  parseMarkdownToAST,
} from "./markdown-utils.ts";

Deno.test("parseMarkdownToAST - simple paragraph", () => {
  const ast = parseMarkdownToAST("Hello world");
  assertExists(ast);
  assertEquals(ast?.type, "Document");
  assertEquals(ast?.children[0]?.type, "Paragraph");
  assertEquals(ast?.children[0]?.content, "Hello world");
});

Deno.test("parseMarkdownToAST - bold text", () => {
  const ast = parseMarkdownToAST("**bold text**");
  assertEquals(ast?.children[0]?.children[0]?.type, "StrongEmphasis");
});

Deno.test("parseMarkdownToAST - lists", () => {
  const ast = parseMarkdownToAST("- Item 1\n- Item 2");
  assertEquals(ast?.children[0]?.type, "BulletList");
  assertEquals(ast?.children[0]?.children.length, 2);
  assertEquals(ast?.children[0]?.children[0]?.type, "ListItem");
});

Deno.test("parseMarkdownToAST - empty input", () => {
  const ast = parseMarkdownToAST("");
  assertEquals(ast, null);
});

Deno.test("cleanMarkdownSyntax - bold markers", () => {
  const node = { type: "StrongEmphasis", content: "**bold**", from: 0, to: 8, children: [] };
  assertEquals(cleanMarkdownSyntax(node), "bold");
});

Deno.test("cleanMarkdownSyntax - italic markers", () => {
  const node = { type: "Emphasis", content: "*italic*", from: 0, to: 8, children: [] };
  assertEquals(cleanMarkdownSyntax(node), "italic");
});

Deno.test("cleanMarkdownSyntax - header markers", () => {
  const node = { type: "ATXHeading2", content: "## Header", from: 0, to: 9, children: [] };
  assertEquals(cleanMarkdownSyntax(node), "Header");
});

Deno.test("extractLinkData - valid link", () => {
  const result = extractLinkData("[link text](https://example.com)");
  assertEquals(result.text, "link text");
  assertEquals(result.href, "https://example.com");
});

Deno.test("extractLinkData - malformed link", () => {
  const result = extractLinkData("not a link");
  assertEquals(result.text, "not a link");
  assertEquals(result.href, "#");
});

Deno.test("astToHTML - paragraph", () => {
  const node = { type: "Paragraph", content: "Hello world", from: 0, to: 11, children: [] };
  assertEquals(astToHTML(node), "<p>Hello world</p>");
});

Deno.test("astToHTML - paragraph inside list item", () => {
  const node = { type: "Paragraph", content: "List item text", from: 0, to: 14, children: [] };
  assertEquals(astToHTML(node, "ListItem"), "List item text");
});

Deno.test("astToHTML - bold text", () => {
  const node = { type: "StrongEmphasis", content: "**bold**", from: 0, to: 8, children: [] };
  assertEquals(astToHTML(node), "<strong>bold</strong>");
});

Deno.test("astToHTML - h1 header", () => {
  const node = { type: "ATXHeading1", content: "# Header", from: 0, to: 8, children: [] };
  assertEquals(astToHTML(node), "<h1>Header</h1>");
});

Deno.test("astToHTML - h2 header", () => {
  const node = { type: "ATXHeading2", content: "## Header", from: 0, to: 9, children: [] };
  assertEquals(astToHTML(node), "<h2>Header</h2>");
});

Deno.test("astToHTML - h3 header", () => {
  const node = { type: "ATXHeading3", content: "### Header", from: 0, to: 10, children: [] };
  assertEquals(astToHTML(node), "<h3>Header</h3>");
});

Deno.test("astToHTML - h4 header", () => {
  const node = { type: "ATXHeading4", content: "#### Header", from: 0, to: 11, children: [] };
  assertEquals(astToHTML(node), "<h4>Header</h4>");
});

Deno.test("astToHTML - h5 header to bold paragraph", () => {
  const node = { type: "ATXHeading5", content: "##### Header", from: 0, to: 12, children: [] };
  assertEquals(astToHTML(node), "<p><strong>Header</strong></p>");
});

Deno.test("astToHTML - h6 header to bold paragraph", () => {
  const node = { type: "ATXHeading6", content: "###### Header", from: 0, to: 13, children: [] };
  assertEquals(astToHTML(node), "<p><strong>Header</strong></p>");
});

Deno.test("astToHTML - skip horizontal rules", () => {
  const node = { type: "HorizontalRule", content: "---", from: 0, to: 3, children: [] };
  assertEquals(astToHTML(node), "");
});

Deno.test("markdownToHTML - simple paragraph", () => {
  assertEquals(markdownToHTML("Hello world"), "<p>Hello world</p>");
});

Deno.test("markdownToHTML - bold text", () => {
  assertEquals(markdownToHTML("**bold text**"), "<p><strong>bold text</strong></p>");
});

Deno.test("markdownToHTML - italic text", () => {
  assertEquals(markdownToHTML("*italic text*"), "<p><em>italic text</em></p>");
});

Deno.test("markdownToHTML - unordered list", () => {
  const markdown = "- Item 1\n- Item 2";
  const expected = "<ul><li>Item 1</li><li>Item 2</li></ul>";
  assertEquals(markdownToHTML(markdown), expected);
});

Deno.test("markdownToHTML - ordered list", () => {
  const markdown = "1. First\n2. Second";
  const expected = "<ol><li>First</li><li>Second</li></ol>";
  assertEquals(markdownToHTML(markdown), expected);
});

Deno.test("markdownToHTML - list with inline formatting", () => {
  const markdown = "- **Bold** item\n- *Italic* item";
  const expected = "<ul><li><strong>Bold</strong> item</li><li><em>Italic</em> item</li></ul>";
  assertEquals(markdownToHTML(markdown), expected);
});

Deno.test("markdownToHTML - H1", () => {
  assertEquals(markdownToHTML("# Header 1"), "<h1>Header 1</h1>");
});

Deno.test("markdownToHTML - H2", () => {
  assertEquals(markdownToHTML("## Header 2"), "<h2>Header 2</h2>");
});

Deno.test("markdownToHTML - H3", () => {
  assertEquals(markdownToHTML("### Header 3"), "<h3>Header 3</h3>");
});

Deno.test("markdownToHTML - H4", () => {
  assertEquals(markdownToHTML("#### Header 4"), "<h4>Header 4</h4>");
});

Deno.test("markdownToHTML - H5 to bold paragraph", () => {
  assertEquals(markdownToHTML("##### Header 5"), "<p><strong>Header 5</strong></p>");
});

Deno.test("markdownToHTML - H6 to bold paragraph", () => {
  assertEquals(markdownToHTML("###### Header 6"), "<p><strong>Header 6</strong></p>");
});

Deno.test("markdownToHTML - horizontal rules removed", () => {
  const markdown = "Text\n\n---\n\nMore text";
  const expected = "<p>Text</p><p>More text</p>";
  assertEquals(markdownToHTML(markdown), expected);
});

Deno.test("markdownToHTML - multiple paragraphs", () => {
  const markdown = "Line 1\n\nLine 2";
  const expected = "<p>Line 1</p><p>Line 2</p>";
  assertEquals(markdownToHTML(markdown), expected);
});

Deno.test("markdownToHTML - empty input", () => {
  assertEquals(markdownToHTML(""), "");
});

Deno.test("markdownToHTML - links", () => {
  assertEquals(
    markdownToHTML("[link text](https://example.com)"),
    '<p><a href="https://example.com" target="_blank">link text</a></p>',
  );
});

Deno.test("markdownToHTML - inline code", () => {
  assertEquals(markdownToHTML("`code`"), "<p><code>code</code></p>");
});

Deno.test("markdownToHTML - code blocks", () => {
  assertEquals(markdownToHTML("```\ncode block\n```"), "<pre><code>code block</code></pre>");
});

Deno.test("markdownToHTML - mixed content", () => {
  const markdown = `Here is a paragraph with **bold** and *italic* text.

1. First item
2. Second item with [a link](https://example.com)`;

  const expected =
    "<p>Here is a paragraph with <strong>bold</strong> and <em>italic</em> text.</p>" +
    '<ol><li>First item</li><li>Second item with <a href="https://example.com" target="_blank">a link</a></li></ol>';

  assertEquals(markdownToHTML(markdown), expected);
});
