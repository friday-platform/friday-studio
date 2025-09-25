import { client, parseResult } from "@atlas/client/v2";
import { stringifyError } from "@atlas/utils";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ToolContext } from "../types.ts";
import { createErrorResponse, createSuccessResponse } from "../utils.ts";

/** Register MCP tool for deleting artifacts */
export function registerArtifactsDeleteTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "artifacts_delete",
    {
      description: "Soft delete artifact (data preserved)",
      inputSchema: {
        artifactId: z.string().describe("Artifact ID"),
        streamId: z.string().describe("SSE stream ID"),
      },
    },
    async ({ artifactId, streamId }): Promise<CallToolResult> => {
      ctx.logger.info("MCP artifacts_delete called", { artifactId, streamId });

      const response = await parseResult(
        client.artifactsStorage[":id"].$delete({ param: { id: artifactId } }),
      );

      if (!response.ok) {
        return createErrorResponse("Failed to delete artifact", stringifyError(response.error));
      }

      return createSuccessResponse({ ...response.data, artifactId, streamId });
    },
  );
}
