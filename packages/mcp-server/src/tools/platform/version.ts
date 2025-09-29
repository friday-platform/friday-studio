import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getVersionInfo } from "../../../../../src/utils/version.ts";
import { createSuccessResponse } from "../utils.ts";

export function registerVersionTool(server: McpServer) {
  server.registerTool(
    "system_version",
    { description: "Get the current version of Atlas.", inputSchema: {} },
    () => {
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
    },
  );
}
