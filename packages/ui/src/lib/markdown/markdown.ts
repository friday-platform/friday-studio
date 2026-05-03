import type { TreeCursor } from "@lezer/common";
import { parser, Table } from "@lezer/markdown";
import { Marked } from "marked";

// ─── marked configuration ──────────────────────────────────────────────
// Single shared instance with GFM tables, breaks, and links with target=_blank.

const marked = new Marked({
  gfm: true,
  breaks: false,
  async: false,
});

/**
 * GitHub-style heading → id slug. Strips inline markdown first so the
 * anchor matches what users see. Powers both table-of-contents links
 * and external deep-links like `?tab=reference#syscall-level-evasion`.
 */
function slugifyHeading(text: string): string {
  // Loop the tag strip so nested patterns like `<scr<script>ipt>` can't
  // reconstitute a tag after a single pass.
  let stripped = text;
  while (true) {
    const next = stripped.replace(/<[^<>]*>/g, "");
    if (next === stripped) break;
    stripped = next;
  }
  return stripped
    .replace(/[*_`~]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const renderer = {
  // Open links in a new tab — except in-page anchors (`#foo`), which must
  // stay same-tab so clicking a TOC entry actually scrolls the page.
  link({ href, text }: { href: string; text: string }): string {
    const target = href.startsWith("#") ? "" : ' target="_blank"';
    return `<a href="${href}"${target}>${text}</a>`;
  },
  heading({ text, depth }: { text: string; depth: number }): string {
    // H5/H6 → bold paragraph (matches prior behavior).
    if (depth >= 5) return `<p><strong>${text}</strong></p>\n`;
    const id = slugifyHeading(text);
    return `<h${depth}${id ? ` id="${id}"` : ""}>${text}</h${depth}>\n`;
  },
  // Strip horizontal rules (matches old behavior)
  hr(): string {
    return "";
  },
};

marked.use({ renderer });

// ─── Lezer AST helpers (preserved for backward compat / tests) ─────────

const markdownParser = parser.configure([Table]);

interface ASTNode {
  type: string;
  from: number;
  to: number;
  content: string;
  children: ASTNode[];
}

export function parseMarkdownToAST(text: string): ASTNode | null {
  if (!text) return null;

  const tree = markdownParser.parse(text);
  const cursor = tree.cursor();

  function buildNode(cursor: TreeCursor): ASTNode {
    const node: ASTNode = {
      type: cursor.type.name,
      from: cursor.from,
      to: cursor.to,
      content: text.slice(cursor.from, cursor.to),
      children: [],
    };

    if (cursor.firstChild()) {
      do {
        node.children.push(buildNode(cursor));
      } while (cursor.nextSibling());
      cursor.parent();
    }

    return node;
  }

  return buildNode(cursor);
}

export function cleanMarkdownSyntax(node: ASTNode): string {
  const content = node.content;

  switch (node.type) {
    case "StrongEmphasis":
      return content.replace(/^(\*\*|__)/, "").replace(/(\*\*|__)$/, "");
    case "Emphasis":
      return content.replace(/^(\*|_)/, "").replace(/(\*|_)$/, "");
    case "Strikethrough":
      return content.replace(/^~~/, "").replace(/~~$/, "");
    case "InlineCode":
      return content.replace(/^`/, "").replace(/`$/, "");
    case "CodeBlock":
      return content.replace(/^```[\w]*\n?/, "").replace(/\n?```$/, "");
    case "ATXHeading1":
    case "ATXHeading2":
    case "ATXHeading3":
    case "ATXHeading4":
    case "ATXHeading5":
    case "ATXHeading6":
      return content.replace(/^#+\s*/, "");
    default:
      return content;
  }
}

export function extractLinkData(content: string): { text: string; href: string } {
  // Linear-time scan for `[text](href)` — a regex with greedy character classes
  // around fixed delimiters can backtrack quadratically on near-matches.
  if (content.startsWith("[")) {
    const labelEnd = content.indexOf("]", 1);
    if (labelEnd > 1 && content[labelEnd + 1] === "(") {
      const hrefStart = labelEnd + 2;
      const hrefEnd = content.indexOf(")", hrefStart);
      if (hrefEnd > hrefStart) {
        return {
          text: content.slice(1, labelEnd),
          href: content.slice(hrefStart, hrefEnd),
        };
      }
    }
  }
  return { text: content, href: "#" };
}

function reconstructParagraphContent(node: ASTNode): string {
  let result = "";
  let lastEnd = node.from;
  const originalContent = node.content;

  for (const child of node.children) {
    if (child.from > lastEnd) {
      const textBetween = originalContent.slice(lastEnd - node.from, child.from - node.from);
      result += textBetween;
    }

    if (child.type === "StrongEmphasis") {
      const innerText = originalContent.slice(child.from - node.from + 2, child.to - node.from - 2);
      result += `<strong>${innerText}</strong>`;
    } else if (child.type === "Emphasis") {
      const innerText = originalContent.slice(child.from - node.from + 1, child.to - node.from - 1);
      result += `<em>${innerText}</em>`;
    } else if (child.type === "Strikethrough") {
      const innerText = originalContent.slice(child.from - node.from + 2, child.to - node.from - 2);
      result += `<del>${innerText}</del>`;
    } else if (child.type === "Link") {
      const linkData = extractLinkData(child.content);
      result += `<a href="${linkData.href}" target="_blank">${linkData.text}</a>`;
    } else if (child.type === "InlineCode") {
      const innerText = child.content.slice(1, -1);
      result += `<code>${innerText}</code>`;
    } else {
      result += astToHTML(child, "Paragraph");
    }

    lastEnd = child.to;
  }

  if (lastEnd < node.to) {
    const textAfter = originalContent.slice(lastEnd - node.from);
    result += textAfter;
  }

  return result;
}

function renderTableCells(row: ASTNode, tag: "th" | "td"): string {
  return row.children
    .filter((c) => c.type === "TableCell")
    .map((cell) => {
      const content =
        cell.children.length > 0
          ? cell.children.map((child) => astToHTML(child, "TableCell")).join("")
          : cell.content;
      return `<${tag}>${content}</${tag}>`;
    })
    .join("");
}

export function astToHTML(node: ASTNode | null, parentType: string = ""): string {
  if (!node) return "";

  const skipTypes = [
    "ListMark",
    "HeaderMark",
    "EmphasisMark",
    "LinkMark",
    "HorizontalRule",
    "TableDelimiter",
  ];
  if (skipTypes.includes(node.type)) {
    return "";
  }

  const renderChildren = (currentParent: string = node.type): string => {
    return node.children
      .map((child) => astToHTML(child, currentParent))
      .filter((html) => html !== "")
      .join("");
  };

  switch (node.type) {
    case "Document":
      return renderChildren();

    case "Paragraph":
      if (parentType === "ListItem") {
        if (node.children.length > 0) {
          return reconstructParagraphContent(node);
        }
        return node.content;
      }
      if (node.children.length > 0) {
        return `<p>${reconstructParagraphContent(node)}</p>`;
      }
      return `<p>${node.content}</p>`;

    case "BulletList":
      return `<ul>${renderChildren()}</ul>`;

    case "OrderedList":
      return `<ol>${renderChildren()}</ol>`;

    case "ListItem": {
      const listContent = node.children
        .filter((child) => child.type !== "ListMark")
        .map((child) => astToHTML(child, "ListItem"))
        .join("");
      return `<li>${listContent}</li>`;
    }

    case "StrongEmphasis":
      return `<strong>${cleanMarkdownSyntax(node)}</strong>`;

    case "Emphasis":
      return `<em>${cleanMarkdownSyntax(node)}</em>`;

    case "Strikethrough":
      return `<del>${cleanMarkdownSyntax(node)}</del>`;

    case "Link": {
      const linkData = extractLinkData(node.content);
      return `<a href="${linkData.href}">${linkData.text}</a>`;
    }

    case "InlineCode":
      return `<code>${cleanMarkdownSyntax(node)}</code>`;

    case "CodeBlock":
    case "FencedCode":
      if (node.children.length > 0) {
        const codeText = node.children.find((child) => child.type === "CodeText");
        if (codeText) {
          return `<pre><code>${codeText.content}</code></pre>`;
        }
      }
      return `<pre><code>${cleanMarkdownSyntax(node)}</code></pre>`;

    case "ATXHeading1": {
      if (node.children.length > 0) {
        const textChildren = node.children.filter((child) => child.type !== "HeaderMark");
        if (textChildren.length > 0) {
          return `<h1>${textChildren.map((child) => astToHTML(child, parentType)).join("")}</h1>`;
        }
      }
      return `<h1>${cleanMarkdownSyntax(node)}</h1>`;
    }
    case "ATXHeading2": {
      if (node.children.length > 0) {
        const textChildren = node.children.filter((child) => child.type !== "HeaderMark");
        if (textChildren.length > 0) {
          return `<h2>${textChildren.map((child) => astToHTML(child, parentType)).join("")}</h2>`;
        }
      }
      return `<h2>${cleanMarkdownSyntax(node)}</h2>`;
    }
    case "ATXHeading3": {
      if (node.children.length > 0) {
        const textChildren = node.children.filter((child) => child.type !== "HeaderMark");
        if (textChildren.length > 0) {
          return `<h3>${textChildren.map((child) => astToHTML(child, parentType)).join("")}</h3>`;
        }
      }
      return `<h3>${cleanMarkdownSyntax(node)}</h3>`;
    }
    case "ATXHeading4": {
      if (node.children.length > 0) {
        const textChildren = node.children.filter((child) => child.type !== "HeaderMark");
        if (textChildren.length > 0) {
          return `<h4>${textChildren.map((child) => astToHTML(child, parentType)).join("")}</h4>`;
        }
      }
      return `<h4>${cleanMarkdownSyntax(node)}</h4>`;
    }
    case "ATXHeading5":
    case "ATXHeading6": {
      if (node.children.length > 0) {
        const textChildren = node.children.filter((child) => child.type !== "HeaderMark");
        if (textChildren.length > 0) {
          return `<p><strong>${textChildren.map((child) => astToHTML(child, parentType)).join("")}</strong></p>`;
        }
      }
      return `<p><strong>${cleanMarkdownSyntax(node)}</strong></p>`;
    }

    case "Table": {
      const headerNode = node.children.find((c) => c.type === "TableHeader");
      const bodyRows = node.children.filter((c) => c.type === "TableRow");
      const thead = headerNode
        ? `<thead><tr>${renderTableCells(headerNode, "th")}</tr></thead>`
        : "";
      const tbody =
        bodyRows.length > 0
          ? `<tbody>${bodyRows.map((row) => `<tr>${renderTableCells(row, "td")}</tr>`).join("")}</tbody>`
          : "";
      return `<table>${thead}${tbody}</table>`;
    }

    case "TableHeader":
    case "TableRow":
    case "TableCell":
      return renderChildren(parentType);

    case "BlockQuote":
      return `<blockquote>${
        node.children.length > 0 ? renderChildren() : node.content
      }</blockquote>`;

    case "HorizontalRule":
      return "";

    default:
      if (node.children.length > 0) {
        return renderChildren(parentType);
      }
      return node.content;
  }
}

// ─── Pipe-table normalizer ─────────────────────────────────────────────
// LLMs often emit pipe-separated lines without the GFM separator row
// (|---|---|). This pre-processing step detects such runs and inserts the
// missing separator so both Lezer and marked recognize them as tables.

function normalizePipeTables(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (isPipeRow(trimmed) && !isGfmSeparator(trimmed)) {
      const cols = countPipeCols(trimmed);

      // Already a proper GFM table — consume it whole
      const nextTrimmed = lines[i + 1]?.trim() ?? "";
      if (isGfmSeparator(nextTrimmed)) {
        result.push(line);
        result.push(lines[i + 1] ?? "");
        let j = i + 2;
        while (j < lines.length) {
          const bodyLine = lines[j]?.trim() ?? "";
          if (isPipeRow(bodyLine) && !isGfmSeparator(bodyLine)) {
            result.push(lines[j] ?? "");
            j++;
          } else {
            break;
          }
        }
        i = j;
        continue;
      }

      // No separator — collect consecutive pipe rows with same column count
      let runEnd = i;
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j]?.trim() ?? "";
        if (isPipeRow(next) && !isGfmSeparator(next) && countPipeCols(next) === cols) {
          runEnd = j;
        } else {
          break;
        }
      }

      // Only transform runs of ≥2 lines (header + at least one data row)
      if (runEnd > i) {
        result.push(ensureWrappedPipes(lines[i] ?? ""));
        result.push(buildSeparator(cols));
        for (let k = i + 1; k <= runEnd; k++) {
          result.push(ensureWrappedPipes(lines[k] ?? ""));
        }
        i = runEnd + 1;
        continue;
      }
    }

    result.push(line);
    i++;
  }

  return result.join("\n");
}

function isPipeRow(line: string): boolean {
  if (line.length === 0) return false;
  const pipes = line.split("|").length - 1;
  return pipes >= 2;
}

function isGfmSeparator(line: string): boolean {
  return /^\|?[\s:]*-{3,}[\s:]*(\|[\s:]*-{3,}[\s:]*)+\|?$/.test(line);
}

function countPipeCols(line: string): number {
  const stripped = line.replace(/^\|/, "").replace(/\|$/, "");
  return stripped.split("|").length;
}

function ensureWrappedPipes(line: string): string {
  let s = line.trim();
  if (!s.startsWith("|")) s = `| ${s}`;
  if (!s.endsWith("|")) s = `${s} |`;
  return s;
}

function buildSeparator(cols: number): string {
  return `| ${Array.from({ length: cols }, () => "---").join(" | ")} |`;
}

// ─── Public API ────────────────────────────────────────────────────────

/**
 * Escape lines that are ONLY a digit followed by a period (with no content
 * after) so marked doesn't interpret them as empty ordered-list markers.
 *
 * CommonMark treats `2.` on its own line as a valid (empty) ordered-list
 * marker starting at 2, rendering as `<ol start="2"><li></li></ol>`. When an
 * LLM replies to "what is 1+1?" with just "2.", that rule swallows the
 * entire answer into an empty list and the user sees a blank bubble.
 *
 * We only escape the period when the line matches `^\d+\.\s*$` — anything
 * followed by real content (`"1. first item"`, `"The answer is 2."`) is
 * untouched.
 */
function preserveBareNumericLines(text: string): string {
  return text.replace(/^(\s*)(\d+)\.([ \t]*)$/gm, "$1$2\\.$3");
}

/**
 * Split single-line numbered runs ("1. foo 2. bar 3. baz") onto their own
 * lines so marked renders them as a real <ol> instead of collapsing into a
 * single <li>. Chat output from LLMs (and humans) frequently arrives this
 * way; CommonMark treats it as one item, but users see "broken list".
 *
 * Only triggers when a line starts with `<digit>.` AND contains ` <digit>. `
 * later in the same line. Multi-line lists, tables ("Score: 9. Out of 10"),
 * decimals, and version strings are untouched.
 */
function splitInlineNumberedRuns(text: string): string {
  return text.replace(/^(\s*)(\d+)\.\s.*$/gm, (line) => {
    if (!/\s\d+\.\s/.test(line)) return line;
    return line.replace(/\s(\d+)\.\s/g, "\n$1. ");
  });
}

/**
 * Convert markdown to HTML using `marked` (GFM-compliant, battle-tested).
 * Pipe-separated lines without a GFM separator row are auto-fixed first.
 */
export function markdownToHTML(markdown: string): string {
  if (!markdown) return "";
  // Normalize CRLF
  const normalized = markdown.replace(/\r\n/g, "\n");
  // Preserve bare "N." answers (e.g. "2." as a reply to arithmetic) that
  // marked would otherwise swallow into an empty <ol><li></li></ol>.
  const preserved = preserveBareNumericLines(normalized);
  // Split inline numbered runs ("1. a 2. b 3. c") onto their own lines so
  // they render as a real <ol> instead of one collapsed <li>.
  const split = splitInlineNumberedRuns(preserved);
  // Auto-fix sloppy pipe tables from LLM output
  const withTables = normalizePipeTables(split);
  // marked.parse() is synchronous when async: false
  const html = marked.parse(withTables) as string;
  // Strip trailing newline that marked adds
  return html.replace(/\n$/, "");
}
