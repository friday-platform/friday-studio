import type { Logger } from "@atlas/logger";
import { tool } from "ai";
import TurndownService from "turndown";
import { z } from "zod";

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024; // 5MB
const DEFAULT_TIMEOUT_MS = 30_000; // 30 seconds
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * Converts HTML to markdown using TurndownService.
 * Strips script, style, meta, and link tags.
 */
function htmlToMarkdown(html: string): string {
  const turndownService = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  });
  turndownService.remove(["script", "style", "meta", "link"]);
  return turndownService.turndown(html);
}

/**
 * Strips HTML tags to extract plain text. Goes through Turndown so the
 * tag handling reuses a real HTML parser (regex-based stripping misses
 * forgiving-parser corner cases like `</script foo="bar">`), then we
 * collapse the resulting markdown to plain text.
 */
function htmlToText(html: string): string {
  const md = htmlToMarkdown(html);
  return md
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // images → alt text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links → label
    .replace(/^#+\s+/gm, "") // heading markers
    .replace(/^\s*>\s+/gm, "") // blockquote markers
    .replace(/^\s*[-*+]\s+/gm, "") // unordered list markers
    .replace(/^\s*\d+\.\s+/gm, "") // ordered list markers
    .replace(/[*_~`]/g, "") // emphasis / inline code
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Creates an AI SDK tool for fetching URL content via HTTP GET.
 * Converts HTML to the requested format (markdown by default).
 * Returns content string on success, error message string on failure.
 *
 * @param logger - Optional logger for per-call progress lines (eval/debug visibility)
 */
export function createFetchTool(logger?: Logger) {
  return tool({
    description:
      "Fetch content from a URL via HTTP GET. Returns markdown by default. " +
      "Use for reading web pages, documentation, APIs. " +
      "If content is thin or empty, the page likely requires JavaScript — escalate to browse.",
    inputSchema: z.object({
      url: z.string().describe("URL to fetch"),
      format: z
        .enum(["markdown", "text", "html"])
        .optional()
        .default("markdown")
        .describe("Output format — markdown (default), plain text, or raw HTML"),
    }),
    execute: async ({ url, format }) => {
      logger?.info(`[fetch] ${url}`);
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

        try {
          const response = await fetch(url, {
            signal: controller.signal,
            headers: {
              "User-Agent": USER_AGENT,
              Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
              "Accept-Language": "en-US,en;q=0.9",
            },
          });

          clearTimeout(timeoutId);

          if (!response.ok) {
            logger?.warn(`[fetch] fail ${response.status}: ${url}`);
            return `Fetch failed: HTTP ${response.status} ${response.statusText}`;
          }

          const contentLength = response.headers.get("content-length");
          if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_SIZE) {
            return "Fetch failed: response exceeds 5MB size limit";
          }

          const arrayBuffer = await response.arrayBuffer();
          if (arrayBuffer.byteLength > MAX_RESPONSE_SIZE) {
            logger?.warn(`[fetch] oversize: ${url}`);
            return "Fetch failed: response exceeds 5MB size limit";
          }

          const content = new TextDecoder().decode(arrayBuffer);
          const contentType = response.headers.get("content-type") ?? "";

          logger?.info(`[fetch] ok ${arrayBuffer.byteLength}b: ${url}`);

          if (format === "html") {
            return content;
          }

          if (format === "text") {
            if (contentType.includes("text/html")) {
              return htmlToText(content);
            }
            return content;
          }

          // Default: markdown
          if (contentType.includes("text/html")) {
            return htmlToMarkdown(content);
          }
          return content;
        } finally {
          clearTimeout(timeoutId);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger?.warn(`[fetch] error: ${url} — ${message.slice(0, 120)}`);
        return `Fetch failed: ${message}`;
      }
    },
  });
}
