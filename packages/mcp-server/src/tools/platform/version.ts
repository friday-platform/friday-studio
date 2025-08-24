import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getVersionInfo } from "../../../../../src/utils/version.ts";
import { createSuccessResponse, type ToolContext } from "../types.ts";

export function registerVersionTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "system_version",
    { description: "Get the current version of Atlas.", inputSchema: {} },
    () => {
      try {
        return createSuccessResponse({
          content: {
            command: "version",
            description: "Get the current version of Atlas.",
            exitCode: 0,
            stdout: getVersionInfo(),
            stderr: "",
            success: true,
            truncated: false,
          },
        });
      } catch (error) {
        ctx.logger.error("Failed to get Atlas version", { error });
        throw new Error("Failed to get Atlas version.");
      }
    },
  );
}
