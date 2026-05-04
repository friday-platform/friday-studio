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
        "Create a new file artifact. Pass file content directly (string for text, base64 for binary) and associate it with the current chat or workspace.",
      inputSchema: {
        data: z
          .preprocess(unstringifyNestedJson, ArtifactDataInputSchema)
          .describe(
            "File payload: { type: 'file', content, mimeType?, originalName?, contentEncoding? }. " +
              "`content` is the file body — a UTF-8 string for text, OR a base64-encoded string with " +
              "`contentEncoding: 'base64'` for binary. The server hashes, sniffs the mime, sizes it, " +
              "and writes to the JetStream Object Store (content-addressed by SHA-256, so identical " +
              "bytes dedup automatically). Example: { type: 'file', content: '# Heading\\n…', " +
              "originalName: 'notes.md' }.",
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
