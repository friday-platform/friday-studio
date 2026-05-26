/**
 * Sync code highlighter for markdown fenced blocks.
 *
 * Shipped as a curated set of common languages so the bundle stays
 * bounded — markdown previews in Discover Spaces, Skills, MCP Catalog,
 * and chat messages all flow through this. Unknown / unspecified
 * languages fall through to a plain escaped `<pre><code>` block.
 *
 * The theme uses design-token CSS vars (`--blue-3`, `--green-3`, etc.)
 * so highlighting automatically tracks the existing dark/light mode
 * switch without a second theme definition. Matches the pattern used
 * by `tools/agent-playground/.../json-highlighter.ts`.
 */

import { createHighlighterCoreSync, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import bashLang from "shiki/langs/bash.mjs";
import cssLang from "shiki/langs/css.mjs";
import diffLang from "shiki/langs/diff.mjs";
import goLang from "shiki/langs/go.mjs";
import htmlLang from "shiki/langs/html.mjs";
import javascriptLang from "shiki/langs/javascript.mjs";
import jsonLang from "shiki/langs/json.mjs";
import jsxLang from "shiki/langs/jsx.mjs";
import markdownLang from "shiki/langs/markdown.mjs";
import pythonLang from "shiki/langs/python.mjs";
import rustLang from "shiki/langs/rust.mjs";
import sqlLang from "shiki/langs/sql.mjs";
import tsxLang from "shiki/langs/tsx.mjs";
import typescriptLang from "shiki/langs/typescript.mjs";
import yamlLang from "shiki/langs/yaml.mjs";

const THEME_NAME = "atlas-code";

const highlighter: HighlighterCore = createHighlighterCoreSync({
  themes: [
    {
      name: THEME_NAME,
      // Shiki requires a `type` for theme resolution; the actual colors are
      // CSS variables that resolve light/dark at render time, so the
      // declared "dark" type is just nominal.
      type: "dark",
      settings: [
        {
          scope: ["comment", "punctuation.definition.comment", "string.comment"],
          settings: { foreground: "var(--color-text-muted, #888)", fontStyle: "italic" },
        },
        {
          scope: [
            "keyword",
            "storage",
            "storage.type",
            "storage.modifier",
            "keyword.control",
            "keyword.operator.new",
            "keyword.operator.expression",
          ],
          settings: { foreground: "var(--purple-3)" },
        },
        {
          scope: [
            "string",
            "string.quoted",
            "string.template",
            "punctuation.definition.string",
          ],
          settings: { foreground: "var(--green-3)" },
        },
        {
          scope: ["constant.numeric", "constant.language", "constant.character.numeric"],
          settings: { foreground: "var(--yellow-3)" },
        },
        {
          scope: ["entity.name.function", "support.function", "meta.function-call"],
          settings: { foreground: "var(--blue-3)" },
        },
        {
          scope: [
            "entity.name.type",
            "entity.name.class",
            "support.type",
            "support.class",
            "entity.other.inherited-class",
          ],
          settings: { foreground: "var(--brown-3)" },
        },
        {
          scope: ["variable", "variable.other", "variable.parameter"],
          settings: { foreground: "var(--color-text)" },
        },
        {
          scope: [
            "variable.language",
            "variable.language.this",
            "variable.language.self",
          ],
          settings: { foreground: "var(--red-3)", fontStyle: "italic" },
        },
        {
          scope: ["entity.name.tag", "punctuation.definition.tag"],
          settings: { foreground: "var(--blue-3)" },
        },
        {
          scope: ["entity.other.attribute-name"],
          settings: { foreground: "var(--yellow-3)" },
        },
        {
          scope: ["markup.inserted", "markup.changed"],
          settings: { foreground: "var(--green-3)" },
        },
        {
          scope: ["markup.deleted"],
          settings: { foreground: "var(--red-3)" },
        },
        {
          scope: ["support.type.property-name", "meta.object-literal.key"],
          settings: { foreground: "var(--blue-3)" },
        },
      ],
      fg: "var(--color-text)",
      bg: "transparent",
    },
  ],
  langs: [
    bashLang,
    cssLang,
    diffLang,
    goLang,
    htmlLang,
    javascriptLang,
    jsonLang,
    jsxLang,
    markdownLang,
    pythonLang,
    rustLang,
    sqlLang,
    tsxLang,
    typescriptLang,
    yamlLang,
  ],
  engine: createJavaScriptRegexEngine(),
});

const SUPPORTED_LANGS = new Set(highlighter.getLoadedLanguages());

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Render a fenced code block as syntax-highlighted HTML. Unknown
 * languages (or no language tag at all) fall back to a plain escaped
 * `<pre><code>` so the caller never has to branch.
 */
export function highlightCodeBlock(code: string, lang: string | undefined): string {
  const normalized = (lang ?? "").trim().toLowerCase();
  if (normalized && SUPPORTED_LANGS.has(normalized)) {
    return highlighter.codeToHtml(code, { lang: normalized, theme: THEME_NAME });
  }
  return `<pre><code>${escapeHtml(code)}</code></pre>`;
}
