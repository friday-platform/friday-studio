/**
 * Workspace reference resource for MCP server
 * Exposes a comprehensive workspace configuration reference
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResourceContext } from "./types.ts";
import workspaceReferenceContent from "./workspace-reference.yml" with { type: "text" };

export function registerWorkspaceReferenceResource(
  server: McpServer,
  context: ResourceContext,
) {
  // Register resource
  server.registerResource(
    "workspace-reference",
    "atlas://reference/workspace",
    {
      name: "Workspace Configuration Reference",
      description: "Comprehensive reference showing all Atlas workspace configuration options",
      mimeType: "text/yaml",
    },
    () => {
      return {
        contents: [{
          uri: "atlas://reference/workspace",
          mimeType: "text/yaml",
          text: workspaceReferenceContent,
        }],
      };
    },
  );

  context.logger.info("Registered workspace reference resource");
}
