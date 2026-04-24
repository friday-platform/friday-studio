import MarkdownIt from "markdown-it";
import { MarkdownParser, MarkdownSerializer, MarkdownSerializerState } from "prosemirror-markdown";
import type { Node } from "prosemirror-model";
import { editorSchema } from "./schema.ts";

// --- Parser ---

const md = MarkdownIt("default", { html: false, linkify: true });

// Disable rules for unsupported elements — standalone tokens (image)
// can't use `ignore: true` since they lack _open/_close variants
md.disable(["image"]);

const parser = new MarkdownParser(editorSchema, md, {
  blockquote: { block: "blockquote" },
  paragraph: { block: "paragraph" },
  list_item: { block: "list_item" },
  bullet_list: { block: "bullet_list" },
  ordered_list: {
    block: "ordered_list",
    getAttrs: (tok) => ({ order: +(tok.attrGet("start") ?? 1) }),
  },
  heading: { block: "heading", getAttrs: (tok) => ({ level: +tok.tag.slice(1) }) },
  code_block: { block: "code_block", noCloseToken: true },
  fence: {
    block: "code_block",
    getAttrs: (tok) => ({ params: tok.info || "" }),
    noCloseToken: true,
  },
  table: { block: "table" },
  thead: { ignore: true },
  tbody: { ignore: true },
  tr: { block: "table_row" },
  th: { block: "table_header" },
  td: { block: "table_cell" },
  hr: { node: "horizontal_rule" },
  hardbreak: { node: "hard_break" },
  em: { mark: "em" },
  strong: { mark: "strong" },
  link: {
    mark: "link",
    getAttrs: (tok) => ({ href: tok.attrGet("href"), title: tok.attrGet("title") || "" }),
  },
  code_inline: { mark: "code", noCloseToken: true },
  softbreak: { node: "hard_break" },
});

/** Zero-width space used as a placeholder for empty paragraphs. Markdown
 *  collapses consecutive blank lines, so empty ProseMirror paragraphs
 *  (from pressing Enter multiple times) would disappear on roundtrip
 *  without a visible-to-markdown-it but invisible-to-humans marker. */
const ZWS = "\u200B";

// --- Serializer ---

function serializeTable(state: MarkdownSerializerState, node: Node): void {
  // Collect rows
  const rows: Node[] = [];
  node.forEach((row) => rows.push(row));
  if (rows.length === 0) return;

  // Compute column widths
  const firstRow = rows[0];
  if (!firstRow) return;
  const colCount = firstRow.childCount;
  const colWidths = new Array<number>(colCount).fill(3); // min "---"

  const cellTexts: string[][] = [];
  for (const row of rows) {
    const rowTexts: string[] = [];
    for (let c = 0; c < row.childCount; c++) {
      const cell = row.child(c);
      const text = cell.textContent;
      rowTexts.push(text);
      if (text.length > (colWidths[c] ?? 0)) colWidths[c] = text.length;
    }
    cellTexts.push(rowTexts);
  }

  // Render rows
  for (let r = 0; r < cellTexts.length; r++) {
    const rowTexts = cellTexts[r];
    if (!rowTexts) continue;
    const line = rowTexts.map((text, c) => ` ${text.padEnd(colWidths[c] ?? 3)} `).join("|");
    state.write(`|${line}|`);
    state.ensureNewLine();

    // Separator after first row (header)
    if (r === 0) {
      const sep = colWidths.map((w) => ` ${"-".repeat(w)} `).join("|");
      state.write(`|${sep}|`);
      state.ensureNewLine();
    }
  }

  state.closeBlock(node);
}

const serializer = new MarkdownSerializer(
  {
    doc(state, node) {
      state.renderContent(node);
    },
    paragraph(state, node) {
      if (node.childCount === 0) {
        state.write(ZWS);
      } else {
        state.renderInline(node);
      }
      state.closeBlock(node);
    },
    heading(state, node) {
      state.write(`${"#".repeat(node.attrs.level as number)} `);
      state.renderInline(node);
      state.closeBlock(node);
    },
    blockquote(state, node) {
      state.wrapBlock("> ", null, node, () => state.renderContent(node));
    },
    code_block(state, node) {
      const info = (node.attrs.params as string) || "";
      state.write(`\`\`\`${info}\n`);
      state.text(node.textContent, false);
      state.write("\n```");
      state.closeBlock(node);
    },
    bullet_list(state, node) {
      state.renderList(node, "  ", () => "- ");
    },
    ordered_list(state, node) {
      const start = (node.attrs.order as number) || 1;
      state.renderList(node, "  ", (i) => `${start + i}. `);
    },
    list_item(state, node) {
      state.renderContent(node);
    },
    text(state, node) {
      state.text(node.text ?? "");
    },
    horizontal_rule(state, node) {
      state.write("---");
      state.closeBlock(node);
    },
    hard_break(state, _node, parent) {
      // Markdown doesn't support line breaks inside headings — a `\` + newline
      // ends the heading and starts a new paragraph. Collapse to a space so
      // the content roundtrips correctly.
      if (parent?.type.name === "heading") {
        state.write(" ");
      } else {
        state.write("\\\n");
      }
    },
    table: serializeTable,
    table_row() {
      // handled by table serializer
    },
    table_header() {
      // handled by table serializer
    },
    table_cell() {
      // handled by table serializer
    },
  },
  {
    strong: { open: "**", close: "**", mixable: true, expelEnclosingWhitespace: true },
    em: { open: "*", close: "*", mixable: true, expelEnclosingWhitespace: true },
    link: {
      open(_state, _mark) {
        return "[";
      },
      close(_state, mark) {
        const href = mark.attrs.href as string;
        const title = mark.attrs.title as string;
        return title ? `](${href} "${title}")` : `](${href})`;
      },
      mixable: false,
    },
    code: { open: "`", close: "`", escape: false },
  },
);

/** Strip ZWS placeholder text from paragraphs, restoring them to empty nodes. */
function stripZwsParagraphs(doc: Node): Node {
  const children: Node[] = [];
  doc.forEach((child) => {
    if (child.type.name === "paragraph" && child.textContent === ZWS) {
      children.push(editorSchema.node("paragraph"));
    } else {
      children.push(child);
    }
  });
  return editorSchema.node("doc", null, children);
}

export function parseMarkdown(markdown: string): Node {
  const doc = parser.parse(markdown);
  if (!doc) {
    return editorSchema.node("doc", null, [editorSchema.node("paragraph")]);
  }
  return stripZwsParagraphs(doc);
}

/** Strip trailing hard_break nodes from paragraphs before serialization.
 *  Markdown can't roundtrip `\` at the end of a paragraph — markdown-it
 *  treats it as a literal backslash, not a line break. Trailing hard breaks
 *  are invisible in rendered output anyway. */
function stripTrailingHardBreaks(para: Node): Node {
  const children: Node[] = [];
  para.forEach((child) => children.push(child));

  while (children.length > 0 && children[children.length - 1]?.type.name === "hard_break") {
    children.pop();
  }

  if (children.length === para.childCount) return para;
  if (children.length === 0) return editorSchema.node("paragraph");
  return editorSchema.node("paragraph", para.attrs, children);
}

export function serializeMarkdown(doc: Node): string {
  const children: Node[] = [];
  doc.forEach((child) => {
    if (child.type.name === "paragraph") {
      children.push(stripTrailingHardBreaks(child));
    } else {
      children.push(child);
    }
  });
  return serializer.serialize(editorSchema.node("doc", null, children));
}
