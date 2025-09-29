import { createAtlasClient } from "@atlas/oapi-client";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../types.ts";
import { createErrorResponse, createSuccessResponse } from "../utils.ts";

export function registerLibraryStoreTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "atlas_library_store",
    {
      description:
        "Store a new item in the Atlas library for future reference and reuse across workspaces. Use this to save reports, templates, session results, artifacts, or any content that should be preserved and discoverable.",
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
        format: z
          .enum(["markdown", "json", "html", "text", "binary"])
          .default("markdown")
          .describe("Format of the content being stored - affects rendering and processing"),
        tags: z
          .array(z.string())
          .max(50)
          .default([])
          .describe(
            "Category tags to help organize and discover this item later (e.g., 'production', 'analysis', 'template')",
          ),
        workspace_id: z.string().optional().describe("Associated workspace ID"),
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
      format = "markdown",
      tags = [],
      workspace_id,
      session_id,
      agent_ids = [],
      source = "agent",
      metadata = {},
    }) => {
      ctx.logger.info("MCP library_store called", {
        type,
        name,
        format,
        contentLength: content.length,
        tagCount: tags.length,
        workspace_id,
        session_id,
      });

      // Note: In the modular pattern, we don't have access to workspaceContext
      // The workspace_id, session_id, and agent_ids should be passed explicitly
      const contextualPayload = {
        type,
        name,
        description,
        content,
        format,
        tags,
        workspace_id,
        session_id,
        agent_ids,
        source,
        metadata,
      };

      const client = createAtlasClient();
      const response = await client.POST("/api/library", { body: contextualPayload });
      if (response.error) {
        ctx.logger.error("Failed to store library item", { error: response.error });
        return createErrorResponse(
          `Failed to store library item: ${response.error.error || response.response.statusText}`,
        );
      }
      const storeResult = response.data;

      ctx.logger.info("MCP library_store response", {
        success: storeResult.success,
        itemId: storeResult.itemId,
        name: storeResult.item?.name,
      });

      return createSuccessResponse({
        success: storeResult.success,
        itemId: storeResult.itemId,
        message: storeResult.message,
        item: storeResult.item,
        path: storeResult.path,
        source: "daemon_api",
        timestamp: new Date().toISOString(),
      });
    },
  );
}
