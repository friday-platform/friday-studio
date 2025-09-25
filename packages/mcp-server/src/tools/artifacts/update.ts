import { client, parseResult } from "@atlas/client/v2";
import { stringifyError } from "@atlas/utils";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ToolContext } from "../types.ts";
import { createErrorResponse, createSuccessResponse } from "../utils.ts";

/** Register MCP tool for updating artifacts */
export function registerArtifactsUpdateTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "artifacts_update",
    {
      description: "Update artifact (creates new revision)",
      inputSchema: {
        artifactId: z.string().describe("Artifact ID"),
        data: z.object({}).describe("New data"),
        revisionMessage: z.string().optional().describe("Change description"),
        streamId: z.string().describe("SSE stream ID"),
      },
    },
    async ({ artifactId, data, revisionMessage, streamId }): Promise<CallToolResult> => {
      ctx.logger.info("MCP artifacts_update called", { artifactId, streamId });

      const response = await parseResult(
        client.artifactsStorage[":id"].$put({
          param: { id: artifactId },
          json: { data, revisionMessage },
        }),
      );

      if (!response.ok) {
        return createErrorResponse("Failed to update artifact", stringifyError(response.error));
      }
      const { artifact } = response.data;
      return createSuccessResponse({ ...artifact, streamId });
    },
  );
}
