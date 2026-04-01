import { client, parseResult } from "@atlas/client/v2";
import { stringifyError } from "@atlas/utils";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ToolContext } from "../types.ts";
import { createErrorResponse, createSuccessResponse } from "../utils.ts";

/** Register MCP tool for listing artifacts by chat */
export function registerArtifactsGetByChatTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "artifacts_get_by_chat",
    {
      description: "List artifacts for current chat",
      inputSchema: {
        limit: z
          .number()
          .int()
          .positive()
          .max(1000)
          .default(100)
          .describe("Max artifacts to return"),
        streamId: z.string().describe("SSE stream ID"),
      },
    },
    async ({ limit, streamId }): Promise<CallToolResult> => {
      ctx.logger.info("MCP artifacts_get_by_chat called", { limit, streamId });

      const response = await parseResult(
        client.artifactsStorage.index.$get({
          // toString() workaround: Daemon coerces to number but narrows type to string|string[]
          // includeData: false — agents only need metadata (id, type, title, summary),
          // not internal file paths which leak server-side filesystem details
          query: { chatId: streamId, limit: limit.toString(), includeData: "false" },
        }),
      );

      if (!response.ok) {
        return createErrorResponse(
          "Failed to retrieve artifacts for chat",
          stringifyError(response.error),
        );
      }
      const { artifacts } = response.data;
      return createSuccessResponse({ artifacts, count: artifacts.length, streamId });
    },
  );
}
