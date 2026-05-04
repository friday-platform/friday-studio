import { client, parseResult } from "@atlas/client/v2";
import { stringifyError } from "@atlas/utils";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ToolContext } from "../types.ts";
import { createErrorResponse, createSuccessResponse, stripArtifactFilePaths } from "../utils.ts";

/** Register MCP tool for retrieving artifacts */
export function registerArtifactsGetTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "artifacts_get",
    {
      description: "Get artifact by ID",
      inputSchema: {
        artifactId: z.string().describe("Artifact ID"),
        revision: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Revision number (defaults to latest)"),
      },
    },
    async ({ artifactId, revision }): Promise<CallToolResult> => {
      ctx.logger.info("MCP artifacts_get called", { artifactId, revision });

      const response = await parseResult(
        // toString() workaround: Daemon coerces to number but narrows type to string|string[]
        client.artifactsStorage[":id"].$get({
          param: { id: artifactId },
          query: { revision: revision?.toString() },
        }),
      );

      if (!response.ok) {
        return createErrorResponse("Failed to retrieve artifact", stringifyError(response.error));
      }
      const { artifact, contents, hint } = response.data;
      return createSuccessResponse({ ...stripArtifactFilePaths(artifact), contents, hint });
    },
  );
}
