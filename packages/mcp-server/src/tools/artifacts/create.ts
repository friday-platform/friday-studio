import { client, parseResult } from "@atlas/client/v2";
import { ArtifactDataSchema, ArtifactTypeSchema } from "@atlas/core/artifacts";
import { stringifyError } from "@atlas/utils";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ToolContext } from "../types.ts";
import { createErrorResponse, createSuccessResponse } from "../utils.ts";

/** Register MCP tool for creating artifacts */
export function registerArtifactsCreateTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "artifacts_create",
    {
      description: "Create a new artifact",
      inputSchema: {
        type: ArtifactTypeSchema.describe("Artifact type"),
        data: ArtifactDataSchema.describe("Type-specific data"),
        summary: z
          .string()
          .min(10)
          .max(500)
          .describe(
            "1-2 sentence summary describing what this artifact contains and its purpose. This summary helps other agents understand the artifact without reading its full contents.",
          ),
        workspaceId: z.string().optional().describe("Workspace ID"),
        streamId: z.string().optional().describe("SSE stream ID"),
      },
    },
    async ({ type, data, summary, workspaceId, streamId }): Promise<CallToolResult> => {
      ctx.logger.info("MCP artifacts_create called", { type, workspaceId, streamId });

      const response = await parseResult(
        client.artifactsStorage.index.$post({
          json: { type, data, summary, workspaceId, chatId: streamId },
        }),
      );

      if (!response.ok) {
        return createErrorResponse("Failed to create artifact", stringifyError(response.error));
      }
      const { artifact } = response.data;
      return createSuccessResponse({ ...artifact, streamId });
    },
  );
}
