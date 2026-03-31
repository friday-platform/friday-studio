/**
 * CodeMirror theme for the playground.
 *
 * Uses CSS custom properties from the atlas design system so the theme
 * adapts automatically to light/dark mode via `prefers-color-scheme`.
 * Syntax colors follow the shiki theme in `apps/web-client` — keys blue,
 * strings green, numbers yellow, booleans purple.
 *
 * Token tags matched against `@lezer/yaml` grammar output.
 *
 * @module
 */

import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

/** Editor chrome — backgrounds, cursors, gutters, selections. */
const atlasEditorTheme = EditorView.theme({
  "&": { color: "var(--color-text)", backgroundColor: "var(--color-surface-1)" },

  ".cm-content": { caretColor: "var(--blue-3)" },

  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--blue-3)" },

  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    { backgroundColor: "var(--color-highlight-1)" },

  ".cm-panels": { backgroundColor: "var(--color-surface-2)", color: "var(--color-text)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--color-border-1)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--color-border-1)" },

  ".cm-searchMatch": {
    backgroundColor: "color-mix(in srgb, var(--blue-3), transparent 75%)",
    outline: "1px solid var(--blue-3)",
  },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "color-mix(in srgb, var(--blue-3), transparent 85%)",
  },

  ".cm-activeLine": { backgroundColor: "var(--color-highlight-1)" },
  ".cm-selectionMatch": {
    backgroundColor: "color-mix(in srgb, var(--green-3), transparent 88%)",
  },

  "&.cm-focused .cm-matchingBracket, &.cm-focused .cm-nonmatchingBracket": {
    backgroundColor: "color-mix(in srgb, var(--blue-3), transparent 70%)",
  },

  ".cm-gutters": { backgroundColor: "var(--color-surface-1)", color: "var(--editor-muted)", border: "none" },

  ".cm-lineNumbers .cm-gutterElement": { padding: "0 3px 0 18px" },

  ".cm-activeLineGutter": { backgroundColor: "var(--color-highlight-1)" },

  '.cm-foldGutter .cm-gutterElement span[title="Fold line"]': { position: "relative", top: "-3px" },

  ".cm-foldPlaceholder": { backgroundColor: "transparent", border: "none", color: "var(--editor-dimmed)" },

  ".cm-tooltip": {
    border: "1px solid var(--color-border-1)",
    backgroundColor: "var(--color-surface-2)",
  },
  ".cm-tooltip .cm-tooltip-arrow:before": {
    borderTopColor: "transparent",
    borderBottomColor: "transparent",
  },
  ".cm-tooltip .cm-tooltip-arrow:after": {
    borderTopColor: "var(--color-surface-2)",
    borderBottomColor: "var(--color-surface-2)",
  },
  ".cm-tooltip-autocomplete": {
    "& > ul > li[aria-selected]": {
      backgroundColor: "var(--color-highlight-1)",
      color: "var(--color-text)",
    },
  },
});

/**
 * Syntax highlight colors — maps lezer tags to atlas color scale.
 *
 * Tag assignments from `@lezer/yaml` styleTags:
 *   Key/Literal, Key/QuotedLiteral → definition(propertyName)
 *   QuotedLiteral → string
 *   Literal → content
 *   BlockLiteralContent → content
 *   BlockLiteralHeader → special(string)
 *   Comment → lineComment
 *   DirectiveName → keyword
 *   DirectiveContent → attributeValue
 *   DirectiveEnd, DocEnd → meta
 *   Anchor, Alias → labelName
 *   Tag → typeName
 *   : , - → separator
 *   ? → punctuation
 *   [ ] → squareBracket
 *   { } → brace
 */
const atlasHighlightStyle = HighlightStyle.define([
  // Keys — blue
  { tag: t.definition(t.propertyName), color: "var(--blue-3)" },
  { tag: [t.propertyName, t.macroName], color: "var(--blue-3)" },

  // Strings — green
  { tag: t.string, color: "var(--green-3)" },
  { tag: t.special(t.string), color: "var(--green-3)" },
  { tag: t.attributeValue, color: "var(--green-3)" },

  // Unquoted values — default text (content tag)
  { tag: t.content, color: "var(--color-text)" },

  // Comments — muted
  { tag: [t.lineComment, t.blockComment, t.comment], color: "var(--editor-muted)" },

  // Keywords / directives — purple
  { tag: t.keyword, color: "var(--purple-3)" },

  // Document markers (--- ...) — muted
  { tag: t.meta, color: "var(--editor-muted)" },

  // Anchors & aliases — yellow
  { tag: t.labelName, color: "var(--yellow-3)" },

  // Tags (!tag) — yellow
  { tag: t.typeName, color: "var(--yellow-3)" },

  // Numbers — yellow
  { tag: [t.number, t.changed], color: "var(--yellow-3)" },

  // Booleans, null — purple
  { tag: [t.atom, t.bool, t.special(t.variableName)], color: "var(--purple-3)" },

  // Separators (: , -) and punctuation — dimmed
  { tag: [t.separator, t.punctuation], color: "var(--editor-dimmed)" },

  // Brackets — dimmed
  { tag: [t.squareBracket, t.brace], color: "var(--editor-dimmed)" },

  // Operators, URLs — brown
  { tag: [t.operator, t.operatorKeyword, t.url, t.escape, t.regexp], color: "var(--brown-3)" },

  // Names — red
  { tag: [t.name, t.deleted, t.character], color: "var(--red-3)" },

  // Functions — blue
  { tag: t.function(t.variableName), color: "var(--blue-3)" },

  // Constants — yellow
  { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: "var(--yellow-3)" },

  // Formatting
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.heading, fontWeight: "bold", color: "var(--blue-3)" },
  { tag: t.invalid, color: "var(--red-3)" },
]);

/** Combined atlas theme extension (editor chrome + syntax highlighting). */
export const atlasTheme = [atlasEditorTheme, syntaxHighlighting(atlasHighlightStyle)];
