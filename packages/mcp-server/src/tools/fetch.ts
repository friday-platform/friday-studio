import { stringifyError } from "@atlas/utils";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "./types.ts";
import { createErrorResponse, createSuccessResponse } from "./utils.ts";
import { executeWebfetch, type WebfetchArgs } from "./webfetch-handler.ts";

/**
 * MCP `webfetch` tool. Dispatches to a NATS worker (`tools.webfetch.call`) when
 * the daemon has wired one up; otherwise runs in-process via the same handler
 * the worker uses.
 */
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
        const args: WebfetchArgs = {
          url: params.url,
          format: params.format,
          timeout: params.timeout,
        };
        const result = ctx.toolDispatcher
          ? await ctx.toolDispatcher.callTool<
              WebfetchArgs,
              Awaited<ReturnType<typeof executeWebfetch>>
            >("webfetch", args)
          : await executeWebfetch(args);
        return createSuccessResponse(result);
      } catch (error) {
        // AbortError is expected behavior (caller cancelled, timeout fired) —
        // surface the message verbatim without logging at error level. Real
        // tool failures still get the "webfetch tool error" prefix + log.
        const message = stringifyError(error);
        const isAbort =
          (error instanceof DOMException && error.name === "AbortError") ||
          (error instanceof Error && error.name === "AbortError") ||
          message.includes("Request was aborted");
        if (isAbort) {
          return createErrorResponse(message);
        }
        ctx.logger.error("webfetch tool error", { error, params });
        return createErrorResponse(`webfetch tool error: ${message}`);
      }
    },
  );
}
