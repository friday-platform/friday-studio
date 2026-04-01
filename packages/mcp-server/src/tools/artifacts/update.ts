import { unstringifyNestedJson } from "@atlas/agent-sdk/vercel-helpers";
import { client, parseResult } from "@atlas/client/v2";
import type { ArtifactDataInput, ArtifactType } from "@atlas/core/artifacts";
import { ArtifactDataInputSchema, ArtifactTypeSchema } from "@atlas/core/artifacts";
import { stringifyError } from "@atlas/utils";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ToolContext } from "../types.ts";
import { createErrorResponse, createSuccessResponse, stripArtifactFilePaths } from "../utils.ts";

/**
 * Wraps raw artifact data with the required {type, version, data} envelope.
 * Accepts either:
 * - Already wrapped: {type: "workspace-plan", version: 1, data: {...}}
 * - Raw inner data: {workspace: {...}, signals: [...], ...}
 */
function wrapArtifactData(type: ArtifactType, rawData: unknown): ArtifactDataInput {
  // First, unstringify if needed
  const data = unstringifyNestedJson(rawData);

  // Check if already wrapped (has type, version, data structure)
  if (data && typeof data === "object" && "type" in data && "version" in data && "data" in data) {
    // Already in correct format, validate and return
    return ArtifactDataInputSchema.parse(data);
  }

  // Wrap raw data with envelope using the type parameter
  const wrapped = { type, version: 1 as const, data };

  return ArtifactDataInputSchema.parse(wrapped);
}

/** Register MCP tool for updating artifacts */
export function registerArtifactsUpdateTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "artifacts_update",
    {
      description: "Update artifact (creates new revision)",
      inputSchema: {
        type: ArtifactTypeSchema.describe("Artifact type is required but should not be changed"),
        artifactId: z.string().describe("Artifact ID"),
        data: z
          .unknown()
          .describe(
            "New artifact data. Can be the raw inner data (e.g., {workspace, signals, agents, jobs} for workspace-plan) or fully wrapped {type, version, data}.",
          ),
        title: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe("Optional new title for the artifact"),
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
    async ({
      artifactId,
      type,
      data: rawData,
      title,
      summary,
      revisionMessage,
    }): Promise<CallToolResult> => {
      ctx.logger.info("MCP artifacts_update called", { artifactId, type });

      // Wrap raw data if needed
      let wrappedData: ArtifactDataInput;
      try {
        wrappedData = wrapArtifactData(type, rawData);
      } catch (err) {
        return createErrorResponse(
          "Invalid artifact data",
          `Failed to parse artifact data for type '${type}': ${stringifyError(err)}`,
        );
      }

      const response = await parseResult(
        client.artifactsStorage[":id"].$put({
          param: { id: artifactId },
          json: { type, data: wrappedData, title, summary, revisionMessage },
        }),
      );

      if (!response.ok) {
        return createErrorResponse("Failed to update artifact", stringifyError(response.error));
      }
      const { artifact } = response.data;
      return createSuccessResponse({ ...stripArtifactFilePaths(artifact) });
    },
  );
}
