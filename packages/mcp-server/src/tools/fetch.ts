import { stringifyError } from "@atlas/utils";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HTMLRewriter } from "@worker-tools/html-rewriter";
import TurndownService from "turndown";
import { z } from "zod";
import type { ToolContext } from "./types.ts";
import { createErrorResponse, createSuccessResponse } from "./utils.ts";

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024; // 5MB
const DEFAULT_TIMEOUT = 30 * 1000; // 30 seconds
const MAX_TIMEOUT = 120 * 1000; // 2 minutes

export function registerFetchTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "webfetch",
    {
      description: `
      - Fetches content from a specified URL
- Takes a URL and optional format as input
- Fetches the URL content, converts to requested format (markdown by default)
- Returns the content in the specified format
- Use this tool when you need to retrieve and analyze web content

Usage notes:
  - The URL must be a fully-formed valid URL
  - HTTP URLs will be automatically upgraded to HTTPS
  - Format options: "markdown" (default), "text", or "html"
  - This tool is read-only and does not modify any files`,
      inputSchema: {
        url: z.string().describe("The URL to fetch content from"),
        format: z
          .enum(["text", "markdown", "html"])
          .default("markdown")
          .describe(
            "The format to return the content in (text, markdown, or html). Defaults to markdown.",
          ),
        timeout: z.number().describe("Optional timeout in seconds (max 120)").optional(),
      },
    },
    async (params) => {
      try {
        // Validate URL
        if (!params.url.startsWith("http://") && !params.url.startsWith("https://")) {
          return createErrorResponse("URL must start with http:// or https://");
        }

        const timeout = Math.min((params.timeout ?? DEFAULT_TIMEOUT / 1000) * 1000, MAX_TIMEOUT);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        // Build Accept header based on requested format with q parameters for fallbacks
        let acceptHeader = "*/*";
        switch (params.format) {
          case "markdown":
            acceptHeader =
              "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1";
            break;
          case "text":
            acceptHeader = "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1";
            break;
          case "html":
            acceptHeader =
              "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1";
            break;
          default:
            acceptHeader =
              "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8";
        }

        const response = await fetch(params.url, {
          signal: controller.signal,
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            Accept: acceptHeader,
            "Accept-Language": "en-US,en;q=0.9",
          },
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`Request failed with status code: ${response.status}`);
        }

        // Check content length
        const contentLength = response.headers.get("content-length");
        if (contentLength && parseInt(contentLength) > MAX_RESPONSE_SIZE) {
          throw new Error("Response too large (exceeds 5MB limit)");
        }

        const arrayBuffer = await response.arrayBuffer();
        if (arrayBuffer.byteLength > MAX_RESPONSE_SIZE) {
          throw new Error("Response too large (exceeds 5MB limit)");
        }

        const content = new TextDecoder().decode(arrayBuffer);
        const contentType = response.headers.get("content-type") || "";

        const title = `${params.url} (${contentType})`;

        // Handle content based on requested format and actual content type
        switch (params.format) {
          case "markdown":
            if (contentType.includes("text/html")) {
              const markdown = convertHTMLToMarkdown(content);
              return createSuccessResponse({ output: markdown, title, metadata: {} });
            }
            return createSuccessResponse({ output: content, title, metadata: {} });

          case "text":
            if (contentType.includes("text/html")) {
              const text = await extractTextFromHTML(content);
              return createSuccessResponse({ output: text, title, metadata: {} });
            }
            return createSuccessResponse({ output: content, title, metadata: {} });

          case "html":
            return createSuccessResponse({ output: content, title, metadata: {} });

          default:
            return createSuccessResponse({ output: content, title, metadata: {} });
        }
      } catch (error) {
        ctx.logger.error("webfetch tool error", { error, params });
        return createErrorResponse(`webfetch tool error: ${stringifyError(error)}`);
      }
    },
  );
}

async function extractTextFromHTML(html: string) {
  let text = "";
  let skipContent = false;

  const rewriter = new HTMLRewriter()
    .on("script, style, noscript, iframe, object, embed", {
      element() {
        skipContent = true;
      },
      text() {
        // Skip text content inside these elements
      },
    })
    .on("*", {
      element(element: { tagName: string }) {
        // Reset skip flag when entering other elements
        if (
          !["script", "style", "noscript", "iframe", "object", "embed"].includes(element.tagName)
        ) {
          skipContent = false;
        }
      },
      text(input: { text: string }) {
        if (!skipContent) {
          text += input.text;
        }
      },
    })
    .transform(new Response(html));

  await rewriter.text();
  return text.trim();
}

function convertHTMLToMarkdown(html: string): string {
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
