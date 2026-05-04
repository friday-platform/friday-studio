import { client, parseResult } from "@atlas/client/v2";
import { stringifyError } from "@atlas/utils";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ToolContext } from "../types.ts";
import { createErrorResponse, createSuccessResponse } from "../utils.ts";

/**
 * Register MCP tool for extracting text from binary artifacts.
 *
 * Routes through the daemon's `/api/artifacts/:id/parse` endpoint, which
 * uses the same `pdfToMarkdown` / `docxToMarkdown` / `pptxToMarkdown`
 * converters that run at upload time. The bytes never leave the daemon —
 * the agent receives parsed markdown only, avoiding the prompt-token
 * cost of round-tripping base64 through the model.
 */
export function registerArtifactsParseTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "parse_artifact",
    {
      description:
        "Extract text from a binary artifact (PDF, DOCX, or PPTX) as markdown. Use whenever you need the contents of a binary artifact for reasoning. Returns `{ markdown, mimeType, filename }`.",
      inputSchema: { artifactId: z.string().describe("Artifact ID of a PDF/DOCX/PPTX file") },
    },
    async ({ artifactId }): Promise<CallToolResult> => {
      ctx.logger.info("MCP parse_artifact called", { artifactId });

      const response = await parseResult(
        client.artifactsStorage[":id"].parse.$get({ param: { id: artifactId } }),
      );

      if (!response.ok) {
        return createErrorResponse("Failed to parse artifact", stringifyError(response.error));
      }
      return createSuccessResponse(response.data);
    },
  );
}
