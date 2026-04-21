/**
 * Multi-language code highlighter for skill reference files.
 *
 * Uses `createHighlighterCoreSync` so consumers get a plain synchronous
 * `codeToHtml` call — no async boundary in render paths. Languages are
 * picked to match what agentskills.io reference files tend to ship:
 * markdown source, TypeScript / JavaScript, Python, Shell, YAML, JSON.
 */

import { createHighlighterCoreSync } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import bashLang from "shiki/langs/bash.mjs";
import jsonLang from "shiki/langs/json.mjs";
import markdownLang from "shiki/langs/markdown.mjs";
import pythonLang from "shiki/langs/python.mjs";
import tsLang from "shiki/langs/typescript.mjs";
import yamlLang from "shiki/langs/yaml.mjs";

/** Shared theme — same dark palette the JSON highlighter uses. */
const theme = {
  name: "atlas-code",
  type: "dark" as const,
  fg: "var(--color-text)",
  bg: "transparent",
  settings: [
    { scope: ["comment"], settings: { foreground: "var(--color-text-muted, gray)" } },
    { scope: ["keyword", "storage.type"], settings: { foreground: "var(--purple-3, #c586c0)" } },
    { scope: ["string"], settings: { foreground: "var(--green-3, #6a9955)" } },
    { scope: ["constant.numeric", "constant.language"], settings: { foreground: "var(--yellow-3, #dcdcaa)" } },
    { scope: ["entity.name.function", "support.function"], settings: { foreground: "var(--blue-3, #dcdcaa)" } },
    { scope: ["entity.name.type", "support.type"], settings: { foreground: "var(--blue-4, #4ec9b0)" } },
    { scope: ["variable.parameter"], settings: { foreground: "var(--color-text)" } },
  ],
};

export const codeHighlighter = createHighlighterCoreSync({
  themes: [theme],
  langs: [tsLang, pythonLang, bashLang, yamlLang, jsonLang, markdownLang],
  engine: createJavaScriptRegexEngine(),
});

/** Extension → shiki lang id. Unknown extensions fall back to plain text. */
const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "typescript",
  jsx: "typescript",
  mjs: "typescript",
  cjs: "typescript",
  py: "python",
  sh: "bash",
  bash: "bash",
  yaml: "yaml",
  yml: "yaml",
  json: "json",
  jsonc: "json",
  md: "markdown",
  markdown: "markdown",
};

/**
 * Resolve a shiki language id from a file path. Returns `null` for files
 * we don't support — caller should render them as plain monospace text.
 */
export function languageFromPath(path: string): string | null {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return null;
  const ext = path.slice(dot + 1).toLowerCase();
  return EXT_TO_LANG[ext] ?? null;
}

/**
 * Highlight `code` as HTML. Returns `null` when the language is unknown
 * so the caller can fall back to a plain `<pre>`.
 */
export function highlightCode(code: string, lang: string | null): string | null {
  if (!lang) return null;
  try {
    return codeHighlighter.codeToHtml(code, { lang, theme: "atlas-code" });
  } catch {
    return null;
  }
}
