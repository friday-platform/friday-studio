import { createAtlasClient } from "@atlas/oapi-client";
import { stringifyError } from "@atlas/utils";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../types.ts";
import { createErrorResponse, createSuccessResponse } from "../utils.ts";

export function registerLibraryTemplatesTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "library_templates",
    {
      description: "List available content generation templates through daemon API",
      inputSchema: {},
    },
    async () => {
      ctx.logger.info("MCP library_templates called");

      const client = createAtlasClient();
      const response = await client.GET("/api/library/templates");
      if (response.error) {
        ctx.logger.error("Failed to list templates", { error: response.error });
        return createErrorResponse(
          `Failed to list library templates: ${stringifyError(response.error)}`,
        );
      }
      const templates = response.data;

      ctx.logger.info("MCP library_templates response", { templateCount: templates.length });

      return createSuccessResponse({
        templates,
        total: templates.length,
        source: "daemon_api",
        timestamp: new Date().toISOString(),
      });
    },
  );
}
