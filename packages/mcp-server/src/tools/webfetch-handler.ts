/**
 * Pure webfetch handler — same per-tool migration shape as bash-handler.
 * Used in-process and via the NATS tool worker. When the worker moves
 * into a sandboxed runtime (Docker / Firecracker), this handler is what
 * lives in the sandbox.
 */

import { HTMLRewriter } from "@worker-tools/html-rewriter";
import TurndownService from "turndown";
import { z } from "zod";

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024; // 5MB
const DEFAULT_TIMEOUT = 30 * 1000;
const MAX_TIMEOUT = 120 * 1000;

export const WebfetchArgsSchema = z.object({
  url: z.string(),
  format: z.enum(["text", "markdown", "html"]).default("markdown"),
  timeout: z.number().optional(),
});
export type WebfetchArgs = z.infer<typeof WebfetchArgsSchema>;

export interface WebfetchResult {
  output: string;
  title: string;
  metadata: Record<string, unknown>;
}

export async function executeWebfetch(
  args: WebfetchArgs,
  opts?: { abortSignal?: AbortSignal },
): Promise<WebfetchResult> {
  if (!args.url.startsWith("http://") && !args.url.startsWith("https://")) {
    throw new Error("URL must start with http:// or https://");
  }

  const timeout = Math.min((args.timeout ?? DEFAULT_TIMEOUT / 1000) * 1000, MAX_TIMEOUT);
  // Compose timeout-based abort with caller-supplied abort. Whichever fires
  // first cancels the in-flight fetch.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  let externalAbortHandler: (() => void) | undefined;
  if (opts?.abortSignal) {
    if (opts.abortSignal.aborted) {
      controller.abort(opts.abortSignal.reason);
    } else {
      externalAbortHandler = () => controller.abort(opts.abortSignal?.reason);
      opts.abortSignal.addEventListener("abort", externalAbortHandler, { once: true });
    }
  }

  let acceptHeader: string;
  switch (args.format) {
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
  }

  try {
    const response = await fetch(args.url, {
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

    const contentLength = response.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_SIZE) {
      throw new Error("Response too large (exceeds 5MB limit)");
    }

    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > MAX_RESPONSE_SIZE) {
      throw new Error("Response too large (exceeds 5MB limit)");
    }

    const content = new TextDecoder().decode(arrayBuffer);
    const contentType = response.headers.get("content-type") || "";
    const title = `${args.url} (${contentType})`;

    switch (args.format) {
      case "markdown":
        if (contentType.includes("text/html")) {
          return { output: convertHTMLToMarkdown(content), title, metadata: {} };
        }
        return { output: content, title, metadata: {} };
      case "text":
        if (contentType.includes("text/html")) {
          return { output: await extractTextFromHTML(content), title, metadata: {} };
        }
        return { output: content, title, metadata: {} };
      case "html":
        return { output: content, title, metadata: {} };
    }
    throw new Error(`Unhandled format: ${args.format}`);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("Request was aborted (timeout or cancellation)");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    if (externalAbortHandler) opts?.abortSignal?.removeEventListener("abort", externalAbortHandler);
  }
}

async function extractTextFromHTML(html: string): Promise<string> {
  let text = "";
  let skipContent = false;

  const rewriter = new HTMLRewriter()
    .on("script, style, noscript, iframe, object, embed", {
      element() {
        skipContent = true;
      },
      text() {
        // Skip
      },
    })
    .on("*", {
      element(element: { tagName: string }) {
        if (
          !["script", "style", "noscript", "iframe", "object", "embed"].includes(element.tagName)
        ) {
          skipContent = false;
        }
      },
      text(input: { text: string }) {
        if (!skipContent) text += input.text;
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
