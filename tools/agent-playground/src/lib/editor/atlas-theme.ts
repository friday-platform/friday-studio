/**
 * CodeMirror theme for the playground.
 *
 * Uses the atlas design system color scale (dark mode values hardcoded
 * since playground is always dark). Syntax colors follow the shiki theme
 * in `apps/web-client` — keys blue, strings green, numbers yellow,
 * booleans purple.
 *
 * Token tags matched against `@lezer/yaml` grammar output.
 *
 * @module
 */

import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

// Dark-mode color scale from apps/web-client/src/app.css
const blue = "hsl(212 96% 78%)";
const green = "hsl(100 79% 78%)";
const yellow = "hsl(42 100% 78%)";
const purple = "hsl(271 100% 82%)";
const brown = "hsl(34 49% 61%)";
const red = "hsl(24 96% 78%)";
const muted = "hsl(40 12% 95% / 0.4)";
const dimmed = "hsl(40 12% 95% / 0.55)";

/** Editor chrome — backgrounds, cursors, gutters, selections. */
const atlasEditorTheme = EditorView.theme(
  {
    "&": { color: "var(--color-text)", backgroundColor: "var(--color-surface-1)" },

    ".cm-content": { caretColor: blue },

    ".cm-cursor, .cm-dropCursor": { borderLeftColor: blue },

    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
      { backgroundColor: "var(--color-highlight-1)" },

    ".cm-panels": { backgroundColor: "var(--color-surface-2)", color: "var(--color-text)" },
    ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--color-border-1)" },
    ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--color-border-1)" },

    ".cm-searchMatch": { backgroundColor: "hsl(212 96% 78% / 0.25)", outline: `1px solid ${blue}` },
    ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "hsl(212 96% 78% / 0.15)" },

    ".cm-activeLine": { backgroundColor: "var(--color-highlight-1)" },
    ".cm-selectionMatch": { backgroundColor: "hsl(100 79% 78% / 0.12)" },

    "&.cm-focused .cm-matchingBracket, &.cm-focused .cm-nonmatchingBracket": {
      backgroundColor: "hsl(212 96% 78% / 0.3)",
    },

    ".cm-gutters": { backgroundColor: "var(--color-surface-1)", color: muted, border: "none" },

    ".cm-lineNumbers .cm-gutterElement": { padding: "0 3px 0 18px" },

    ".cm-activeLineGutter": { backgroundColor: "var(--color-highlight-1)" },

    '.cm-foldGutter .cm-gutterElement span[title="Fold line"]': { position: "relative", top: "-3px" },

    ".cm-foldPlaceholder": { backgroundColor: "transparent", border: "none", color: dimmed },

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
  },
  { dark: true },
);

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
  { tag: t.definition(t.propertyName), color: blue },
  { tag: [t.propertyName, t.macroName], color: blue },

  // Strings — green
  { tag: t.string, color: green },
  { tag: t.special(t.string), color: green },
  { tag: t.attributeValue, color: green },

  // Unquoted values — default text (content tag)
  { tag: t.content, color: dimmed },

  // Comments — muted
  { tag: [t.lineComment, t.blockComment, t.comment], color: muted },

  // Keywords / directives — purple
  { tag: t.keyword, color: purple },

  // Document markers (--- ...) — muted
  { tag: t.meta, color: muted },

  // Anchors & aliases — yellow
  { tag: t.labelName, color: yellow },

  // Tags (!tag) — yellow
  { tag: t.typeName, color: yellow },

  // Numbers — yellow
  { tag: [t.number, t.changed], color: yellow },

  // Booleans, null — purple
  { tag: [t.atom, t.bool, t.special(t.variableName)], color: purple },

  // Separators (: , -) and punctuation — dimmed
  { tag: [t.separator, t.punctuation], color: dimmed },

  // Brackets — dimmed
  { tag: [t.squareBracket, t.brace], color: dimmed },

  // Operators, URLs — brown
  { tag: [t.operator, t.operatorKeyword, t.url, t.escape, t.regexp], color: brown },

  // Names — red
  { tag: [t.name, t.deleted, t.character], color: red },

  // Functions — blue
  { tag: t.function(t.variableName), color: blue },

  // Constants — yellow
  { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: yellow },

  // Formatting
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.heading, fontWeight: "bold", color: blue },
  { tag: t.invalid, color: red },
]);

/** Combined atlas theme extension (editor chrome + syntax highlighting). */
export const atlasTheme = [atlasEditorTheme, syntaxHighlighting(atlasHighlightStyle)];
