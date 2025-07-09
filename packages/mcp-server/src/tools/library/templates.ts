import { z } from "zod";
import type { ToolContext } from "../types.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSuccessResponse } from "../types.ts";
import { fetchWithTimeout, handleDaemonResponse } from "../utils.ts";

export function registerLibraryTemplatesTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "atlas_library_templates",
    {
      description: "List available content generation templates through daemon API",
      inputSchema: {},
    },
    async () => {
      ctx.logger.info("MCP library_templates called");

      try {
        const response = await fetchWithTimeout(`${ctx.daemonUrl}/api/library/templates`);
        const templates = await handleDaemonResponse(response, "library_templates", ctx.logger);

        ctx.logger.info("MCP library_templates response", {
          templateCount: templates.length,
        });

        return createSuccessResponse({
          templates,
          total: templates.length,
          source: "daemon_api",
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        ctx.logger.error("MCP library_templates failed", { error });
        throw error;
      }
    },
  );
}
