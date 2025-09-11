/**
 * Atlas Resource Tools - AI SDK Compatible
 */

import { tool } from "ai";
import { z } from "zod/v4";

const ATLAS_RESOURCES = {
  "atlas://guides/workspace-creation": {
    name: "Atlas Workspace Creation Guide",
    description: "Comprehensive guide for creating Atlas workspaces with patterns and examples",
    mimeType: "text/markdown",
    filePath: new URL("./workspace-creation-guide.md", import.meta.url).pathname,
  },
  "atlas://guides/mcp-servers": {
    name: "Atlas MCP Servers Configuration Guide",
    description:
      "Comprehensive guide for configuring MCP servers in Atlas workspaces with production-ready patterns",
    mimeType: "text/markdown",
    filePath: new URL("./mcp-servers-guide.md", import.meta.url).pathname,
  },
  "atlas://guides/slack-setup": {
    name: "Slack Agent Authentication & Configuration",
    description: "Guide for configuring Slack agent integration.",
    mimeType: "text/markdown",
    filePath: new URL("../../../../bundled-agents/src/slack/slack-setup.md", import.meta.url)
      .pathname,
  },
  "atlas://reference/workspace": {
    name: "Atlas Workspace Reference",
    description: "Complete YAML reference for workspace configuration",
    mimeType: "text/yaml",
    filePath: new URL("./workspace-reference.yml", import.meta.url).pathname,
  },
} as const;

export const resourceReadTool = tool({
  description: `Read an Atlas documentation resource by URI. This tool provides access to comprehensive guides and documentation stored as Atlas resources.

Available resources:
- atlas://guides/workspace-creation - Comprehensive workspace creation guide with patterns and examples
- atlas://guides/mcp-servers - MCP servers configuration guide with production-ready patterns
- atlas://guides/slack-setup - Slack agent authentication and token setup guide
- atlas://reference/workspace - Workspace YAML reference documentation

Use this tool to access detailed technical documentation when helping users with workspace creation, configuration, or troubleshooting.`,
  inputSchema: z.object({
    uri: z.string().describe("The resource URI to read (e.g., atlas://guides/workspace-creation)"),
  }),
  execute: async ({ uri }) => {
    const resource = ATLAS_RESOURCES[uri as keyof typeof ATLAS_RESOURCES];

    if (!resource) {
      const availableUris = Object.keys(ATLAS_RESOURCES).join(", ");
      throw new Error(`Resource not found: ${uri}. Available resources: ${availableUris}`);
    }

    try {
      const content = await Deno.readTextFile(resource.filePath);

      return {
        uri,
        name: resource.name,
        description: resource.description,
        mimeType: resource.mimeType,
        content,
        size: content.length,
        lines: content.split("\n").length,
      };
    } catch (error) {
      throw new Error(`Failed to read resource ${uri}: ${(error as Error).message}`);
    }
  },
});
