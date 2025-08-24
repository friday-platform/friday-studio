import type { TreeCursor } from "@lezer/common";
import { parser } from "@lezer/markdown";

// Configure parser with GFM extensions
const markdownParser = parser.configure([
  // Add GFM tables, strikethrough, etc if needed
]);

// Node structure for rendering
export interface ASTNode {
  type: string;
  from: number;
  to: number;
  content: string;
  children: ASTNode[];
}

/**
 * Parse markdown text into a Lezer AST tree structure
 */
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

/**
 * Clean markdown syntax from text content
 */
export function cleanMarkdownSyntax(node: ASTNode): string {
  const content = node.content;

  switch (node.type) {
    case "StrongEmphasis":
      // Remove ** or __ markers
      return content.replace(/^(\*\*|__)/, "").replace(/(\*\*|__)$/, "");

    case "Emphasis":
      // Remove * or _ markers
      return content.replace(/^(\*|_)/, "").replace(/(\*|_)$/, "");

    case "Strikethrough":
      // Remove ~~ markers
      return content.replace(/^~~/, "").replace(/~~$/, "");

    case "InlineCode":
      // Remove backtick markers
      return content.replace(/^`/, "").replace(/`$/, "");

    case "CodeBlock":
      // Remove triple backticks and language identifier
      return content.replace(/^```[\w]*\n?/, "").replace(/\n?```$/, "");

    case "ATXHeading1":
    case "ATXHeading2":
    case "ATXHeading3":
    case "ATXHeading4":
    case "ATXHeading5":
    case "ATXHeading6":
      // Remove # symbols from headings
      return content.replace(/^#+\s*/, "");

    default:
      return content;
  }
}

/**
 * Extract link URL and text from markdown link syntax
 */
export function extractLinkData(content: string): { text: string; href: string } {
  const match = content.match(/\[([^\]]+)\]\(([^)]+)\)/);
  return { text: match?.[1] ?? content, href: match?.[2] ?? "#" };
}

/**
 * Reconstruct paragraph content with proper inline element handling
 */
function reconstructParagraphContent(node: ASTNode): string {
  let result = "";
  let lastEnd = node.from;
  const originalContent = node.content;

  // Process each child element
  for (const child of node.children) {
    // Add any text before this child
    if (child.from > lastEnd) {
      const textBetween = originalContent.slice(lastEnd - node.from, child.from - node.from);
      result += textBetween;
    }

    // Process the child element
    if (child.type === "StrongEmphasis") {
      // Extract text between markers
      const innerText = originalContent.slice(child.from - node.from + 2, child.to - node.from - 2);
      result += `<strong>${innerText}</strong>`;
    } else if (child.type === "Emphasis") {
      // Extract text between markers
      const innerText = originalContent.slice(child.from - node.from + 1, child.to - node.from - 1);
      result += `<em>${innerText}</em>`;
    } else if (child.type === "Strikethrough") {
      // Extract text between markers
      const innerText = originalContent.slice(child.from - node.from + 2, child.to - node.from - 2);
      result += `<del>${innerText}</del>`;
    } else if (child.type === "Link") {
      const linkData = extractLinkData(child.content);
      result += `<a href="${linkData.href}">${linkData.text}</a>`;
    } else if (child.type === "InlineCode") {
      const innerText = child.content.slice(1, -1); // Remove backticks
      result += `<code>${innerText}</code>`;
    } else {
      // For other types, use the regular astToHTML
      result += astToHTML(child, "Paragraph");
    }

    lastEnd = child.to;
  }

  // Add any remaining text after the last child
  if (lastEnd < node.to) {
    const textAfter = originalContent.slice(lastEnd - node.from);
    result += textAfter;
  }

  return result;
}

/**
 * Convert AST node to HTML string
 */
export function astToHTML(node: ASTNode | null, parentType: string = ""): string {
  if (!node) return "";

  // Skip marker nodes
  const skipTypes = ["ListMark", "HeaderMark", "EmphasisMark", "LinkMark", "HorizontalRule"];
  if (skipTypes.includes(node.type)) {
    return "";
  }

  // Process children recursively
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
      // Skip <p> wrapper if inside ListItem
      if (parentType === "ListItem") {
        // For list items, we need to handle mixed content (text + inline elements)
        if (node.children.length > 0) {
          return reconstructParagraphContent(node);
        }
        return node.content;
      }
      // Regular paragraphs
      if (node.children.length > 0) {
        return `<p>${reconstructParagraphContent(node)}</p>`;
      }
      return `<p>${node.content}</p>`;

    case "BulletList":
      return `<ul>${renderChildren()}</ul>`;

    case "OrderedList":
      return `<ol>${renderChildren()}</ol>`;

    case "ListItem": {
      // Skip ListMark children and unwrap Paragraph children
      const listContent = node.children
        .filter((child) => child.type !== "ListMark")
        .map((child) => astToHTML(child, "ListItem"))
        .join("");
      return `<li>${listContent}</li>`;
    }

    case "StrongEmphasis":
      // These are handled in reconstructParagraphContent when inside paragraphs
      // This is a fallback for standalone usage
      return `<strong>${cleanMarkdownSyntax(node)}</strong>`;

    case "Emphasis":
      // These are handled in reconstructParagraphContent when inside paragraphs
      // This is a fallback for standalone usage
      return `<em>${cleanMarkdownSyntax(node)}</em>`;

    case "Strikethrough":
      // These are handled in reconstructParagraphContent when inside paragraphs
      // This is a fallback for standalone usage
      return `<del>${cleanMarkdownSyntax(node)}</del>`;

    case "Link": {
      const linkData = extractLinkData(node.content);
      return `<a href="${linkData.href}">${linkData.text}</a>`;
    }

    case "InlineCode":
      return `<code>${cleanMarkdownSyntax(node)}</code>`;

    case "CodeBlock":
    case "FencedCode":
      // Code blocks may have nested structure, check children first
      if (node.children.length > 0) {
        // Look for CodeText child
        const codeText = node.children.find((child) => child.type === "CodeText");
        if (codeText) {
          return `<pre><code>${codeText.content}</code></pre>`;
        }
      }
      return `<pre><code>${cleanMarkdownSyntax(node)}</code></pre>`;

    // Convert headers to bold paragraphs
    case "ATXHeading1":
    case "ATXHeading2":
    case "ATXHeading3":
    case "ATXHeading4":
    case "ATXHeading5":
    case "ATXHeading6":
      // Headers have their text in children, skipping the HeaderMark
      if (node.children.length > 0) {
        const textChildren = node.children.filter((child) => child.type !== "HeaderMark");
        if (textChildren.length > 0) {
          const headerText = textChildren.map((child) => astToHTML(child, parentType)).join("");
          return `<p><strong>${headerText}</strong></p>`;
        }
      }
      return `<p><strong>${cleanMarkdownSyntax(node)}</strong></p>`;

    case "BlockQuote":
      return `<blockquote>${
        node.children.length > 0 ? renderChildren() : node.content
      }</blockquote>`;

    case "HorizontalRule":
      // Skip horizontal rules entirely
      return "";

    default:
      // For unknown types, just render children or content
      if (node.children.length > 0) {
        return renderChildren(parentType);
      }
      return node.content;
  }
}

/**
 * Main function to convert markdown to HTML
 */
export function markdownToHTML(markdown: string): string {
  const ast = parseMarkdownToAST(markdown);
  return astToHTML(ast);
}
