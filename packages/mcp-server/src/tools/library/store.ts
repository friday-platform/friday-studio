import { createAtlasClient } from "@atlas/oapi-client";
import { stringifyError } from "@atlas/utils";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../types.ts";
import { createErrorResponse, createSuccessResponse } from "../utils.ts";

export function registerLibraryStoreTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "library_store",
    {
      description:
        "Store a new item in the library for future reference and reuse across workspaces. Use this to save reports, templates, session results, artifacts, or any content that should be preserved and discoverable.",
      inputSchema: {
        type: z
          .enum(["report", "session_archive", "template", "artifact", "user_upload"])
          .describe(
            "Category of content being stored - determines indexing and discovery behavior",
          ),
        name: z
          .string()
          .min(1)
          .max(255)
          .describe(
            "Descriptive title for the item that will appear in search results and listings",
          ),
        description: z
          .string()
          .max(1000)
          .optional()
          .describe(
            "Optional detailed description explaining what the item contains and its purpose",
          ),
        content: z
          .string()
          .min(1)
          .describe("The main content/data to be stored in the library item"),
        mime_type: z
          .string()
          .default("text/markdown")
          .describe("MIME type of the content (e.g., text/markdown, application/json, text/plain)"),
        tags: z
          .array(z.string())
          .max(50)
          .default([])
          .describe(
            "Category tags to help organize and discover this item later (e.g., 'production', 'analysis', 'template')",
          ),
        workspace_id: z.string().optional().describe("Associated workspace ID"),
        workspace_name: z
          .string()
          .optional()
          .describe("Human-readable workspace name (primary key for memory)"),
        session_id: z.string().optional().describe("Associated session ID"),
        agent_ids: z
          .array(z.string())
          .default([])
          .describe("Array of agent IDs that created this item"),
        source: z
          .enum(["agent", "job", "user", "system"])
          .default("agent")
          .describe("Source of the item"),
        metadata: z
          .record(z.string(), z.unknown())
          .default({})
          .describe("Additional metadata object"),
      },
    },
    async ({
      type,
      name,
      description,
      content,
      mime_type = "text/markdown",
      tags = [],
      workspace_id,
      workspace_name,
      session_id,
      agent_ids = [],
      source = "agent",
      metadata = {},
    }) => {
      ctx.logger.info("MCP library_store called", {
        type,
        name,
        mime_type,
        contentLength: content.length,
        tagCount: tags.length,
        workspace_id,
        workspace_name,
        session_id,
      });

      const client = createAtlasClient();
      const response = await client.POST("/api/library", {
        // @ts-expect-error the library endpoint doesn't currently validate the input.
        body: {
          type,
          name,
          description,
          content,
          mime_type,
          tags,
          workspace_id,
          workspace_name,
          session_id,
          agent_ids,
          source,
          metadata,
        },
      });
      if (response.error) {
        ctx.logger.error("Failed to store library item", { error: response.error });
        return createErrorResponse(
          `Failed to store library item: ${stringifyError(response.error)}`,
        );
      }
      const storeResult = response.data;

      ctx.logger.info("MCP library_store response", {
        success: storeResult.success,
        itemId: storeResult.itemId,
        name,
      });

      return createSuccessResponse({
        success: storeResult.success,
        itemId: storeResult.itemId,
        message: storeResult.message,
        item: storeResult.item,
        source: "daemon_api",
        timestamp: new Date().toISOString(),
      });
    },
  );
}
