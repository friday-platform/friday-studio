import { unstringifyNestedJson } from "@atlas/agent-sdk/vercel-helpers";
import { client, parseResult } from "@atlas/client/v2";
import { ArtifactDataInputSchema, ArtifactTypeSchema } from "@atlas/core/artifacts";
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
        type: ArtifactTypeSchema.describe("Artifact type is required but should not be changed"),
        artifactId: z.string().describe("Artifact ID"),
        data: z.preprocess(unstringifyNestedJson, ArtifactDataInputSchema).describe("New data"),
        summary: z
          .string()
          .min(10)
          .max(500)
          .describe(
            "1-2 sentence summary describing what this artifact contains and its purpose. This summary helps other agents understand the artifact without reading its full contents.",
          ),
        revisionMessage: z.string().optional().describe("Change description"),
      },
    },
    async ({ artifactId, type, data, summary, revisionMessage }): Promise<CallToolResult> => {
      ctx.logger.info("MCP artifacts_update called", { artifactId });

      const response = await parseResult(
        client.artifactsStorage[":id"].$put({
          param: { id: artifactId },
          json: { type, data, summary, revisionMessage },
        }),
      );

      if (!response.ok) {
        return createErrorResponse("Failed to update artifact", stringifyError(response.error));
      }
      const { artifact } = response.data;
      return createSuccessResponse({ ...artifact });
    },
  );
}
