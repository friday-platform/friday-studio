import { baseKeymap } from "prosemirror-commands";
import { dropCursor } from "prosemirror-dropcursor";
import { buildKeymap } from "prosemirror-example-setup";
import { gapCursor } from "prosemirror-gapcursor";
import { history } from "prosemirror-history";
import {
  InputRule,
  inputRules,
  textblockTypeInputRule,
  wrappingInputRule,
} from "prosemirror-inputrules";
import { keymap } from "prosemirror-keymap";
import { Slice, type Schema } from "prosemirror-model";
import type { Command } from "prosemirror-state";
import { Plugin, TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { parseMarkdown } from "./markdown.ts";
import { tableGuardPlugin } from "./node-views.ts";

/** Typing `---` at the start of a line inserts a horizontal rule + new paragraph. */
function hrRule(schema: Schema): InputRule {
  return new InputRule(/^---$/, (state, _match, start, _end) => {
    const $start = state.doc.resolve(start);
    const from = $start.before($start.depth);
    const to = $start.after($start.depth);

    const hrType = schema.nodes.horizontal_rule;
    const paraType = schema.nodes.paragraph;
    if (!hrType || !paraType) return null;
    const hr = hrType.create();
    const paragraph = paraType.create();
    const tr = state.tr.replaceWith(from, to, [hr, paragraph]);
    tr.setSelection(TextSelection.create(tr.doc, from + hr.nodeSize + 1));
    return tr;
  });
}

/** Structural input rules (headings, lists, blockquotes, code blocks) without
 *  typographic rules like emDash that interfere with `---` → hr conversion. */
function buildEditorInputRules(schema: Schema): InputRule[] {
  const rules: InputRule[] = [hrRule(schema)];

  if (schema.nodes.blockquote) {
    rules.push(wrappingInputRule(/^\s*>\s$/, schema.nodes.blockquote));
  }
  if (schema.nodes.ordered_list) {
    rules.push(
      wrappingInputRule(
        /^(\d+)\.\s$/,
        schema.nodes.ordered_list,
        (match) => ({ order: +(match[1] ?? 1) }),
        (match, node) => node.childCount + (node.attrs.order as number) === +(match[1] ?? 1),
      ),
    );
  }
  if (schema.nodes.bullet_list) {
    rules.push(wrappingInputRule(/^\s*([-+*])\s$/, schema.nodes.bullet_list));
  }
  if (schema.nodes.code_block) {
    rules.push(
      textblockTypeInputRule(/^```(\w+)?\s$/, schema.nodes.code_block, (match) => ({
        params: match[1] || "",
      })),
    );
  }
  if (schema.nodes.heading) {
    rules.push(
      textblockTypeInputRule(/^(#{1,6})\s$/, schema.nodes.heading, (match) => ({
        level: (match[1] ?? "").length,
      })),
    );
  }

  return rules;
}

/** Shift+Enter in a heading splits it: text before cursor stays as heading,
 *  text after cursor moves to a new paragraph below. In non-heading blocks,
 *  falls through to the default hard_break behavior. */
function exitHeading(schema: Schema): Command {
  return (state, dispatch) => {
    const { $head } = state.selection;
    if ($head.parent.type !== schema.nodes.heading) return false;

    if (dispatch) {
      const paragraphType = schema.nodes.paragraph;
      if (!paragraphType) return false;
      // Split the heading at cursor, making the new block a paragraph
      const tr = state.tr.split($head.pos, 1, [{ type: paragraphType }]);
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

const URL_RE = /^https?:\/\/\S+$/;

/** Handles link click (open in new tab) and paste-to-link (bare URL → link mark). */
function linkPlugin(schema: Schema): Plugin {
  return new Plugin({
    props: {
      handleClick(_view: EditorView, _pos: number, event: MouseEvent) {
        const anchor = (event.target as HTMLElement).closest("a");
        if (!anchor) return false;
        const href = anchor.getAttribute("href");
        if (!href) return false;
        globalThis.open(href, "_blank", "noopener,noreferrer");
        return true;
      },
      handlePaste(view: EditorView, event: ClipboardEvent) {
        const text = event.clipboardData?.getData("text/plain")?.trim();
        if (!text || !URL_RE.test(text)) return false;

        const { from, to } = view.state.selection;
        const linkType = schema.marks.link;
        if (!linkType) return false;
        const linkMark = linkType.create({ href: text });

        // Text selected → wrap selection with link mark, keep selection text
        // No selection → insert the URL as linked text
        const label = from === to ? text : view.state.doc.textBetween(from, to);
        const node = schema.text(label, [linkMark]);
        view.dispatch(view.state.tr.replaceSelectionWith(node, false));
        return true;
      },
    },
  });
}

/** Semantic tags that ProseMirror's schema can parse into meaningful structure. */
const SEMANTIC_HTML_RE = /<(?:p|h[1-6]|ul|ol|li|blockquote|pre|table|th|td|tr)\b/i;

/** Parses pasted plain text as markdown instead of inserting as unformatted text.
 *  Defers to ProseMirror's HTML parser only when the clipboard HTML contains
 *  semantic tags (e.g. from a web page). Code editors put syntax-highlighted
 *  HTML on the clipboard (just divs/spans) which has no useful structure. */
function markdownPastePlugin(): Plugin {
  return new Plugin({
    props: {
      handlePaste(view: EditorView, event: ClipboardEvent) {
        // If clipboard HTML has semantic structure, let ProseMirror parse it
        const html = event.clipboardData?.getData("text/html");
        if (html && SEMANTIC_HTML_RE.test(html)) return false;

        const text = event.clipboardData?.getData("text/plain");
        if (!text) return false;

        const doc = parseMarkdown(text);
        const content = doc.content;
        const isSingleParagraph =
          content.childCount === 1 && content.firstChild?.type.name === "paragraph";
        const slice = isSingleParagraph ? new Slice(content, 1, 1) : new Slice(content, 0, 0);

        view.dispatch(view.state.tr.replaceSelection(slice));
        return true;
      },
    },
  });
}

export function buildPlugins(schema: Schema): Plugin[] {
  return [
    inputRules({ rules: buildEditorInputRules(schema) }),
    keymap({ "Shift-Enter": exitHeading(schema) }),
    keymap(buildKeymap(schema)),
    keymap(baseKeymap),
    history(),
    dropCursor(),
    gapCursor(),
    tableGuardPlugin(),
    linkPlugin(schema),
    markdownPastePlugin(),
  ];
}
