import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getVersionInfo } from "../../../../../src/utils/version.ts";
import { createSuccessResponse } from "../utils.ts";

export function registerVersionTool(server: McpServer) {
  server.registerTool(
    "system_version",
    { description: "Get the current platform version.", inputSchema: {} },
    () => {
      return createSuccessResponse({
        content: {
          command: "version",
          description: "Get the current platform version.",
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
