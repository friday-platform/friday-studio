import { describe, expect, it } from "vitest";
import {
  astToHTML,
  cleanMarkdownSyntax,
  extractLinkData,
  markdownToHTML,
  parseMarkdownToAST,
} from "./markdown.ts";

// ─── Lezer AST helpers (backward-compat unit tests) ────────────────────

describe("parseMarkdownToAST", () => {
  it("simple paragraph", () => {
    const ast = parseMarkdownToAST("Hello world");
    expect(ast).toBeDefined();
    expect(ast?.type).toEqual("Document");
    expect(ast?.children[0]?.type).toEqual("Paragraph");
    expect(ast?.children[0]?.content).toEqual("Hello world");
  });

  it("bold text", () => {
    const ast = parseMarkdownToAST("**bold text**");
    expect(ast?.children[0]?.children[0]?.type).toEqual("StrongEmphasis");
  });

  it("lists", () => {
    const ast = parseMarkdownToAST("- Item 1\n- Item 2");
    expect(ast?.children[0]?.type).toEqual("BulletList");
    expect(ast?.children[0]?.children.length).toEqual(2);
    expect(ast?.children[0]?.children[0]?.type).toEqual("ListItem");
  });

  it("empty input", () => {
    const ast = parseMarkdownToAST("");
    expect(ast).toEqual(null);
  });
});

describe("cleanMarkdownSyntax", () => {
  it("bold markers", () => {
    const node = { type: "StrongEmphasis", content: "**bold**", from: 0, to: 8, children: [] };
    expect(cleanMarkdownSyntax(node)).toEqual("bold");
  });

  it("italic markers", () => {
    const node = { type: "Emphasis", content: "*italic*", from: 0, to: 8, children: [] };
    expect(cleanMarkdownSyntax(node)).toEqual("italic");
  });

  it("header markers", () => {
    const node = { type: "ATXHeading2", content: "## Header", from: 0, to: 9, children: [] };
    expect(cleanMarkdownSyntax(node)).toEqual("Header");
  });
});

describe("extractLinkData", () => {
  it("valid link", () => {
    const result = extractLinkData("[link text](https://example.com)");
    expect(result.text).toEqual("link text");
    expect(result.href).toEqual("https://example.com");
  });

  it("malformed link", () => {
    const result = extractLinkData("not a link");
    expect(result.text).toEqual("not a link");
    expect(result.href).toEqual("#");
  });
});

describe("astToHTML", () => {
  it("paragraph", () => {
    const node = { type: "Paragraph", content: "Hello world", from: 0, to: 11, children: [] };
    expect(astToHTML(node)).toEqual("<p>Hello world</p>");
  });

  it("paragraph inside list item", () => {
    const node = { type: "Paragraph", content: "List item text", from: 0, to: 14, children: [] };
    expect(astToHTML(node, "ListItem")).toEqual("List item text");
  });

  it("bold text", () => {
    const node = { type: "StrongEmphasis", content: "**bold**", from: 0, to: 8, children: [] };
    expect(astToHTML(node)).toEqual("<strong>bold</strong>");
  });

  it("h1 header", () => {
    const node = { type: "ATXHeading1", content: "# Header", from: 0, to: 8, children: [] };
    expect(astToHTML(node)).toEqual("<h1>Header</h1>");
  });

  it("h2 header", () => {
    const node = { type: "ATXHeading2", content: "## Header", from: 0, to: 9, children: [] };
    expect(astToHTML(node)).toEqual("<h2>Header</h2>");
  });

  it("h3 header", () => {
    const node = { type: "ATXHeading3", content: "### Header", from: 0, to: 10, children: [] };
    expect(astToHTML(node)).toEqual("<h3>Header</h3>");
  });

  it("h4 header", () => {
    const node = { type: "ATXHeading4", content: "#### Header", from: 0, to: 11, children: [] };
    expect(astToHTML(node)).toEqual("<h4>Header</h4>");
  });

  it("h5 header to bold paragraph", () => {
    const node = { type: "ATXHeading5", content: "##### Header", from: 0, to: 12, children: [] };
    expect(astToHTML(node)).toEqual("<p><strong>Header</strong></p>");
  });

  it("h6 header to bold paragraph", () => {
    const node = { type: "ATXHeading6", content: "###### Header", from: 0, to: 13, children: [] };
    expect(astToHTML(node)).toEqual("<p><strong>Header</strong></p>");
  });

  it("skip horizontal rules", () => {
    const node = { type: "HorizontalRule", content: "---", from: 0, to: 3, children: [] };
    expect(astToHTML(node)).toEqual("");
  });
});

// ─── markdownToHTML (now uses `marked`) ────────────────────────────────
// Tests use .toContain() for structural checks since marked's whitespace
// differs from the old hand-rolled renderer but produces identical visual output.

describe("markdownToHTML", () => {
  it("simple paragraph", () => {
    expect(markdownToHTML("Hello world")).toContain("<p>Hello world</p>");
  });

  it("bold text", () => {
    const result = markdownToHTML("**bold text**");
    expect(result).toContain("<strong>bold text</strong>");
  });

  it("italic text", () => {
    const result = markdownToHTML("*italic text*");
    expect(result).toContain("<em>italic text</em>");
  });

  it("unordered list", () => {
    const result = markdownToHTML("- Item 1\n- Item 2");
    expect(result).toContain("<ul>");
    expect(result).toContain("<li>Item 1</li>");
    expect(result).toContain("<li>Item 2</li>");
    expect(result).toContain("</ul>");
  });

  it("ordered list", () => {
    const result = markdownToHTML("1. First\n2. Second");
    expect(result).toContain("<ol>");
    expect(result).toContain("<li>First</li>");
    expect(result).toContain("<li>Second</li>");
    expect(result).toContain("</ol>");
  });

  it("list with inline formatting", () => {
    const result = markdownToHTML("- **Bold** item\n- *Italic* item");
    expect(result).toContain("<strong>Bold</strong> item");
    expect(result).toContain("<em>Italic</em> item");
  });

  it("bare numeric answer renders as text, not empty ordered list", () => {
    // An arithmetic reply like "2." was being eaten by marked's ordered-
    // list marker rule, producing <ol start="2"><li></li></ol> — the chat
    // bubble ended up empty.
    const result = markdownToHTML("2.");
    expect(result).not.toContain("<ol");
    expect(result).toContain("2.");
  });

  it("bare numeric with leading whitespace still preserved", () => {
    const result = markdownToHTML("  4.  ");
    expect(result).not.toContain("<ol");
    expect(result).toContain("4.");
  });

  it("real ordered list with content still parses correctly", () => {
    const result = markdownToHTML("1. First item\n2. Second item");
    expect(result).toContain("<ol>");
    expect(result).toContain("<li>First item</li>");
    expect(result).toContain("<li>Second item</li>");
  });

  it("single-line numbered run splits into a real ordered list", () => {
    // LLM (and human) output frequently arrives as "1. a 2. b 3. c" on a
    // single line. CommonMark collapses it into one <li>; users see a
    // broken list. We split before each ` <digit>. ` so it renders right.
    const result = markdownToHTML("1. PR failed 2. Dental AI 3. RTX 5080");
    expect(result).toContain("<ol>");
    expect(result).toContain("<li>PR failed</li>");
    expect(result).toContain("<li>Dental AI</li>");
    expect(result).toContain("<li>RTX 5080</li>");
  });

  it("does not split decimals or version strings inside paragraphs", () => {
    const result = markdownToHTML("Version is 1.2.3 and pi is 3.14");
    expect(result).not.toContain("<ol>");
  });

  it("does not split a paragraph that just happens to contain numerals", () => {
    const result = markdownToHTML("The score was 9. Out of 10 it's good.");
    // Plain text paragraph — no leading numbered marker, so the trailing
    // `9.` shouldn't trigger a list.
    expect(result).not.toContain("<ol>");
  });

  it("H1 gets a slug id", () => {
    expect(markdownToHTML("# Header 1")).toContain('<h1 id="header-1">Header 1</h1>');
  });

  it("H2 gets a slug id", () => {
    expect(markdownToHTML("## Header 2")).toContain('<h2 id="header-2">Header 2</h2>');
  });

  it("H3 gets a slug id", () => {
    expect(markdownToHTML("### Header 3")).toContain('<h3 id="header-3">Header 3</h3>');
  });

  it("H4 gets a slug id", () => {
    expect(markdownToHTML("#### Header 4")).toContain('<h4 id="header-4">Header 4</h4>');
  });

  it("heading slug matches GitHub-style (strips punctuation and markdown)", () => {
    expect(markdownToHTML("## Syscall-Level Evasion")).toContain(
      'id="syscall-level-evasion"',
    );
    expect(markdownToHTML("## What's *new* here?")).toContain('id="what-s-new-here"');
  });

  it("in-page anchor links skip target=_blank", () => {
    const html = markdownToHTML("[see](#foo) and [out](https://example.com)");
    expect(html).toContain('<a href="#foo">see</a>');
    expect(html).toContain('<a href="https://example.com" target="_blank">out</a>');
  });

  it("H5 to bold paragraph", () => {
    const result = markdownToHTML("##### Header 5");
    expect(result).toContain("<strong>Header 5</strong>");
  });

  it("H6 to bold paragraph", () => {
    const result = markdownToHTML("###### Header 6");
    expect(result).toContain("<strong>Header 6</strong>");
  });

  it("horizontal rules removed", () => {
    const result = markdownToHTML("Text\n\n---\n\nMore text");
    expect(result).toContain("Text");
    expect(result).toContain("More text");
    expect(result).not.toContain("<hr");
  });

  it("multiple paragraphs", () => {
    const result = markdownToHTML("Line 1\n\nLine 2");
    expect(result).toContain("<p>Line 1</p>");
    expect(result).toContain("<p>Line 2</p>");
  });

  it("empty input", () => {
    expect(markdownToHTML("")).toEqual("");
  });

  it("links open in new tab", () => {
    const result = markdownToHTML("[link text](https://example.com)");
    expect(result).toContain('href="https://example.com"');
    expect(result).toContain('target="_blank"');
    expect(result).toContain("link text");
  });

  it("inline code", () => {
    expect(markdownToHTML("`code`")).toContain("<code>code</code>");
  });

  it("code blocks", () => {
    const result = markdownToHTML("```\ncode block\n```");
    expect(result).toContain("<pre>");
    expect(result).toContain("<code>");
    expect(result).toContain("code block");
  });

  it("mixed content", () => {
    const markdown = `Here is a paragraph with **bold** and *italic* text.

1. First item
2. Second item with [a link](https://example.com)`;

    const result = markdownToHTML(markdown);
    expect(result).toContain("<strong>bold</strong>");
    expect(result).toContain("<em>italic</em>");
    expect(result).toContain("<ol>");
    expect(result).toContain("<li>First item</li>");
    expect(result).toContain('href="https://example.com"');
  });

  it("nested bullet list", () => {
    const markdown = `- Item 1
    - Nested item`;
    const result = markdownToHTML(markdown);
    expect(result).toContain("<ul>");
    expect(result).toContain("Item 1");
    expect(result).toContain("Nested item");
  });

  it("ordered list with nested bullets", () => {
    const markdown = `1. First item
    - Sub bullet
2. Second item`;
    const result = markdownToHTML(markdown);
    expect(result).toContain("<ol>");
    expect(result).toContain("First item");
    expect(result).toContain("Sub bullet");
    expect(result).toContain("Second item");
  });

  it("deeply nested lists", () => {
    const markdown = `1. Top level
    - Second level
        - Third level`;
    const result = markdownToHTML(markdown);
    expect(result).toContain("Top level");
    expect(result).toContain("Second level");
    expect(result).toContain("Third level");
  });

  it("LLM-generated table with plain text cells", () => {
    const markdown = `| Bundle Type | Typical Savings |
|---|---|
| Auto + Renters | 5–15% on both policies |
| Auto + Auto (multi-vehicle) | 10–25% on auto |
| Auto + RV/Trailer | 5–15% on both |
| Auto + Renters + RV (triple bundle) | 15–25% total portfolio savings |`;
    const result = markdownToHTML(markdown);
    expect(result).toContain("<table>");
    expect(result).toContain("<th>");
    expect(result).toContain("Bundle Type");
    expect(result).toContain("Typical Savings");
    expect(result).toContain("<td>");
    expect(result).toContain("Auto + Renters");
    expect(result).toContain("5–15% on both policies");
    expect(result).toContain("15–25% total portfolio savings");
    expect(result).toContain("</table>");
    expect(result).not.toContain("<p>|");
    expect(result).not.toContain("|---|");
  });

  it("LLM-generated table with bold and emoji cells", () => {
    const markdown = `| Carrier | Auto | Renters | Travel Trailer | Bundle Discount |
|---|---|---|---|---|
| **Allstate** | ✅ | ✅ | ✅ | Up to 25% |
| **Progressive** | ✅ | ✅ | ✅ | Up to 15% |
| **Farmers** | ✅ | ✅ | ✅ (via Foremost) | Up to 20% |
| **State Farm** | ✅ | ✅ | ❌ (limited) | Up to 20% |
| **GEICO** | ✅ | ✅ | ❌ | Up to 25% (auto only) |`;
    const result = markdownToHTML(markdown);
    expect(result).toContain("<table>");
    expect(result).toContain("<th>");
    expect(result).toContain("Carrier");
    expect(result).toContain("Bundle Discount");
    expect(result).toContain("<strong>Allstate</strong>");
    expect(result).toContain("<strong>Progressive</strong>");
    expect(result).toContain("<strong>GEICO</strong>");
    expect(result).toContain("✅");
    expect(result).toContain("❌");
    expect(result).toContain("Up to 25%");
    expect(result).toContain("✅ (via Foremost)");
    expect(result).toContain("</table>");
  });

  it("LLM-generated table with surrounding prose", () => {
    const markdown = `## Bundling Savings Potential

This is your **single biggest savings lever**. Here's how bundling could work:

| Bundle Type | Typical Savings |
|---|---|
| Auto + Renters | 5–15% on both policies |
| Auto + Auto (multi-vehicle) | 10–25% on auto |

Allstate and Progressive are the strongest candidates.`;
    const result = markdownToHTML(markdown);
    expect(result).toMatch(/<h2[^>]*>/);
    expect(result).toContain("<table>");
    expect(result).toContain("Bundle Type");
    expect(result).toContain("Auto + Renters");
    expect(result).toContain("</table>");
    expect(result).toContain("Allstate and Progressive are the strongest candidates.");
    expect(result).not.toContain("<p>|");
  });

  it("LLM-generated summary table with multiple text columns", () => {
    const markdown = `| Policy | Top Pick | Runner-Up | Key Reason |
|---|---|---|---|
| 2018 Audi Q5 | State Farm or GEICO | Farmers | Competitive luxury rates, multi-vehicle discount |
| 2024 Porsche Cayenne | Chubb | Progressive | Agreed Value, luxury vehicle expertise |
| Renters | Lemonade | State Farm | Cheapest standalone, good bundled |`;
    const result = markdownToHTML(markdown);
    expect(result).toContain("<table>");
    expect(result).toContain("<th>");
    expect(result).toContain("Top Pick");
    expect(result).toContain("Runner-Up");
    expect(result).toContain("State Farm or GEICO");
    expect(result).toContain("Agreed Value, luxury vehicle expertise");
    expect(result).toContain("</table>");
  });

  // ─── Sloppy pipe table normalization ───────────────────────────────

  it("sloppy pipe-separated lines become a table", () => {
    const markdown = `Name | Age | Role
Alice | 30 | Engineer
Bob | 25 | Designer`;
    const result = markdownToHTML(markdown);
    expect(result).toContain("<table>");
    expect(result).toContain("<th>");
    expect(result).toContain("Name");
    expect(result).toContain("<td>");
    expect(result).toContain("Alice");
    expect(result).toContain("</table>");
  });

  it("single pipe line is not a table", () => {
    const result = markdownToHTML("This has | pipes | but is one line.");
    expect(result).not.toContain("<table>");
    expect(result).toContain("<p>");
  });

  it("sloppy table in mixed content", () => {
    const markdown = `Some text.

A | B | C
1 | 2 | 3
4 | 5 | 6

More text.`;
    const result = markdownToHTML(markdown);
    expect(result).toContain("<p>Some text.</p>");
    expect(result).toContain("<table>");
    expect(result).toContain("<p>More text.</p>");
  });

  it("blockquote", () => {
    const result = markdownToHTML("> This is a quote");
    expect(result).toContain("<blockquote>");
    expect(result).toContain("This is a quote");
  });

  it("strikethrough", () => {
    const result = markdownToHTML("~~deleted~~");
    expect(result).toContain("<del>deleted</del>");
  });
});
