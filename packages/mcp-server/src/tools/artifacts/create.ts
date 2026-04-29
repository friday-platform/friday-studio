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
        "Create a new artifact (summary, workspace-plan, calendar-schedule, slack-summary, table, file, web-search, skill-draft, database)",
      inputSchema: {
        data: z
          .preprocess(unstringifyNestedJson, ArtifactDataInputSchema)
          .describe(
            "Artifact envelope: { type, version, data }. type must be one of: summary, workspace-plan, calendar-schedule, slack-summary, table, file, web-search, skill-draft, database. version is always 1 (except workspace-plan v2). data is the type-specific payload. Example for summary: { type: 'summary', version: 1, data: 'text content here' }",
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
