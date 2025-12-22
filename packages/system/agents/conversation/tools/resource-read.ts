/**
 * Atlas Resource Tools - AI SDK Compatible
 */

import { readFile } from "node:fs/promises";
import { objectKeys, stringifyError } from "@atlas/utils";
import { tool } from "ai";
import { z } from "zod";

const ATLAS_RESOURCES = {
  "atlas://guides/slack-setup": {
    name: "Slack Agent Authentication & Configuration",
    description: "Guide for configuring Slack agent integration.",
    mimeType: "text/markdown",
    filePath: new URL("../../../../bundled-agents/src/slack/slack-setup.md", import.meta.url)
      .pathname,
  },
} as const;

const resourceKeys = objectKeys(ATLAS_RESOURCES);

export const resourceReadTool = tool({
  description: `Read an Atlas documentation resource by URI. This tool provides access to comprehensive guides and documentation stored as Atlas resources.

Available resources:
- atlas://guides/slack-setup - Slack agent authentication and token setup guide

Use this tool to access detailed technical documentation when helping users with configuration or troubleshooting.`,
  inputSchema: z.object({ uri: z.enum(resourceKeys).describe("The resource URI to read") }),
  execute: async ({ uri }) => {
    const resource = ATLAS_RESOURCES[uri];

    if (!resource) {
      const availableUris = Object.keys(ATLAS_RESOURCES).join(", ");
      throw new Error(`Resource not found: ${uri}. Available resources: ${availableUris}`);
    }

    try {
      const content = await readFile(resource.filePath, "utf-8");
      return { uri, name: resource.name, description: resource.description, content };
    } catch (error) {
      throw new Error(`Failed to read resource ${uri}: ${stringifyError(error)}`);
    }
  },
});
