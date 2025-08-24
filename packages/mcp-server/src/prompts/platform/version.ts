/**
 * Signals list tool for MCP server
 * Lists available signals within a workspace through the daemon API
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PromptContext } from "../types.ts";
import { createSuccessResponse } from "../types.ts";

export function registerSystemVersionPrompt(server: McpServer, ctx: PromptContext) {
  server.registerPrompt(
    "system_version",
    { title: "System Version", description: "Get the current version of Atlas.", argsSchema: {} },
    () => {
      ctx.logger.info("MCP system_version called");

      return createSuccessResponse(
        `Use the \`system_version\` tool to get the version of Atlas. Return using markdown syntax to format the response. DO NOT include any other text in your response. DO NOT use dividers in the markdown.`,
      );
    },
  );
}
