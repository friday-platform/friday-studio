import { unstringifyNestedJson } from "@atlas/agent-sdk/vercel-helpers";
import { client, parseResult } from "@atlas/client/v2";
import { ArtifactDataInputSchema } from "@atlas/core/artifacts";
import { stringifyError } from "@atlas/utils";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ToolContext } from "../types.ts";
import { createErrorResponse, createSuccessResponse, stripArtifactFilePaths } from "../utils.ts";

/** Register MCP tool for creating artifacts */
export function registerArtifactsCreateTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "artifacts_create",
    {
      description:
        "Create a new file artifact. Stores a file by path and associates it with the current chat or workspace.",
      inputSchema: {
        data: z
          .preprocess(unstringifyNestedJson, ArtifactDataInputSchema)
          .describe(
            "Artifact envelope: { type, version, data }. Currently only type 'file' is supported. version is always 1. data is the file payload: { path: '/path/to/file' }. Example: { type: 'file', version: 1, data: { path: '/tmp/content.md' } }. To store text/markdown content, write it to a file first, then pass the path here.",
          ),
        title: z
          .string()
          .min(1)
          .max(200)
          .describe(
            "Short, descriptive title for the artifact (e.g., 'Weekly Calendar Summary', 'Q4 Sales Data')",
          ),
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
    async ({ data, title, summary, workspaceId, streamId }): Promise<CallToolResult> => {
      ctx.logger.info("MCP artifacts_create called", { type: data.type, workspaceId, streamId });

      const payload = { data, title, summary, workspaceId, chatId: streamId };

      const response = await parseResult(client.artifactsStorage.index.$post({ json: payload }));

      if (!response.ok) {
        return createErrorResponse("Failed to create artifact", stringifyError(response.error));
      }
      const { artifact } = response.data;
      return createSuccessResponse({ ...stripArtifactFilePaths(artifact), streamId });
    },
  );
}
