import { jsonHighlighter } from "./json-highlighter.ts";

/**
 * Render a tool call's `input` / `output` payload as syntax-highlighted JSON.
 *
 * Two reasons this needs a memoising wrapper:
 *
 *   1. The call site is `{@html formatRawOutput(data)}` inside a snippet that
 *      re-evaluates on every parent re-render. During streaming the parent
 *      message rebuilds on every chunk, and Shiki's `codeToHtml` for a
 *      50-email JSON payload runs ~2-4ms of regex tokenisation. Without
 *      caching that turned into ~6% of total CPU during the email-fetch
 *      reproducer (profiled 2026-05-12).
 *
 *   2. The same `output` object reference is what we already preserve via the
 *      tool-call ref stabiliser in `extractToolCalls`, so a `WeakMap` keyed
 *      on the object reference hits as soon as the call's data settles.
 *
 * The string path uses a small LRU because string inputs (e.g. raw text
 * stdout) don't have a stable reference to key on, but identical content
 * across re-renders is the common case. 64 entries is plenty for a chat
 * with a handful of expanded drawers and bounded to keep memory predictable.
 */

const objectCache = new WeakMap<object, string>();

const STRING_CACHE_MAX = 64;
const stringCache = new Map<string, string>();

function escapeHTML(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function highlight(jsonStr: string): string {
  return jsonHighlighter.codeToHtml(jsonStr, { lang: "json", theme: "atlas-json" });
}

export function formatRawOutput(output: unknown): string {
  if (output === null || output === undefined) {
    return highlight(String(output));
  }

  if (typeof output === "object") {
    const cached = objectCache.get(output as object);
    if (cached !== undefined) return cached;
    let jsonStr: string;
    try {
      jsonStr = JSON.stringify(output, null, 2);
    } catch {
      const fallback = escapeHTML(String(output));
      objectCache.set(output as object, fallback);
      return fallback;
    }
    const result = highlight(jsonStr);
    objectCache.set(output as object, result);
    return result;
  }

  if (typeof output === "string") {
    const cached = stringCache.get(output);
    if (cached !== undefined) return cached;
    let result: string;
    try {
      const parsed: unknown = JSON.parse(output);
      result = highlight(JSON.stringify(parsed, null, 2));
    } catch {
      result = escapeHTML(output);
    }
    if (stringCache.size >= STRING_CACHE_MAX) {
      const firstKey = stringCache.keys().next().value;
      if (firstKey !== undefined) stringCache.delete(firstKey);
    }
    stringCache.set(output, result);
    return result;
  }

  return highlight(String(output));
}
