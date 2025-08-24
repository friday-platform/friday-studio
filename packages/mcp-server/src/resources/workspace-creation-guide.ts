/**
 * Workspace creation guide resource for MCP server
 * Registers the workspace creation guide with patterns and examples
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResourceContext } from "./types.ts";
import workspaceCreationGuideContent from "./workspace-creation-guide.md" with { type: "text" };
import workspaceReferenceContent from "./workspace-reference.yml" with { type: "text" };

export function registerWorkspaceCreationGuideResource(
  server: McpServer,
  context: ResourceContext,
) {
  // Register resource
  server.registerResource(
    "workspace-creation-guide",
    "atlas://guides/workspace-creation",
    {
      name: "Atlas Workspace Creation Guide",
      description: "Comprehensive guide for creating Atlas workspaces with patterns and examples",
      mimeType: "text/markdown",
    },
    () => {
      let content = workspaceCreationGuideContent;

      // Replace workspace reference placeholder
      content = content.replace("{{WORKSPACE_REFERENCE}}", workspaceReferenceContent);

      // content = content.replace("{{AVAILABLE_TOOLS}}", toolsList);

      return {
        contents: [
          { uri: "atlas://guides/workspace-creation", mimeType: "text/markdown", text: content },
        ],
      };
    },
  );

  context.logger.info("Registered workspace creation guide resource");
}
