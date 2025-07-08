import { z } from "zod/v4";
import type { ToolHandler } from "./types.ts";
import { createSuccessResponse } from "./types.ts";
import TurndownService from "turndown";
import { HTMLRewriter } from "@worker-tools/html-rewriter";
import DESCRIPTION from "./webfetch.txt" with { type: "txt" };

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024; // 5MB
const DEFAULT_TIMEOUT = 30 * 1000; // 30 seconds
const MAX_TIMEOUT = 120 * 1000; // 2 minutes

const schema = z.object({
  url: z.string().describe("The URL to fetch content from"),
  format: z
    .enum(["text", "markdown", "html"])
    .describe("The format to return the content in (text, markdown, or html)"),
  timeout: z
    .number()
    .min(0)
    .max(MAX_TIMEOUT / 1000)
    .describe("Optional timeout in seconds (max 120)")
    .optional(),
});

export const webfetchTool: ToolHandler<typeof schema> = {
  name: "webfetch",
  description: DESCRIPTION,
  inputSchema: schema,
  handler: async (params, { logger }) => {
    // Validate URL
    if (!params.url.startsWith("http://") && !params.url.startsWith("https://")) {
      throw new Error("URL must start with http:// or https://");
    }

    const timeout = Math.min((params.timeout ?? DEFAULT_TIMEOUT / 1000) * 1000, MAX_TIMEOUT);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(params.url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
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
    let output: string;

    switch (params.format) {
      case "text":
        if (contentType.includes("text/html")) {
          output = await extractTextFromHTML(content);
        } else {
          output = content;
        }
        break;

      case "markdown":
        if (contentType.includes("text/html")) {
          output = convertHTMLToMarkdown(content);
        } else {
          output = "```\n" + content + "\n```";
        }
        break;

      default:
        output = content;
        break;
    }

    return createSuccessResponse({
      output,
      title,
      metadata: {},
    });
  },
};

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
      element(element) {
        // Reset skip flag when entering other elements
        if (
          !["script", "style", "noscript", "iframe", "object", "embed"].includes(element.tagName)
        ) {
          skipContent = false;
        }
      },
      text(input) {
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
