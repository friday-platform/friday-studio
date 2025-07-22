/**
 * Atlas Resource Tools - AI SDK Compatible
 */

import { z } from "zod";
import { tool } from "ai";
import workspaceCreationGuideContent from "./resources/workspace-creation-guide.md" with {
  type: "text",
};
import workspaceReferenceContent from "./resources/workspace-reference.yml" with { type: "text" };

/**
 * Available Atlas resource URIs and their content
 */
const ATLAS_RESOURCES = {
  "atlas://guides/workspace-creation": {
    name: "Atlas Workspace Creation Guide",
    description: "Comprehensive guide for creating Atlas workspaces with patterns and examples",
    mimeType: "text/markdown",
    content: workspaceCreationGuideContent.replace(
      "{{WORKSPACE_REFERENCE}}",
      workspaceReferenceContent,
    ),
  },
  "atlas://reference/workspace": {
    name: "Atlas Workspace Reference",
    description: "Complete YAML reference for workspace configuration",
    mimeType: "text/yaml",
    content: workspaceReferenceContent,
  },
} as const;

/**
 * Resource Tools
 *
 * Tools for accessing Atlas documentation and guides
 */
export const resourceTools = {
  read_atlas_resource: tool({
    description:
      `Read an Atlas documentation resource by URI. This tool provides access to comprehensive guides and documentation stored as Atlas resources.

Available resources:
- atlas://guides/workspace-creation - Comprehensive workspace creation guide with patterns and examples
- atlas://reference/workspace - Workspace YAML reference documentation

Use this tool to access detailed technical documentation when helping users with workspace creation, configuration, or troubleshooting.`,
    parameters: z.object({
      uri: z.string().describe(
        "The resource URI to read (e.g., atlas://guides/workspace-creation)",
      ),
    }),
    execute: ({ uri }) => {
      const resource = ATLAS_RESOURCES[uri as keyof typeof ATLAS_RESOURCES];

      if (!resource) {
        const availableUris = Object.keys(ATLAS_RESOURCES).join(", ");
        throw new Error(`Resource not found: ${uri}. Available resources: ${availableUris}`);
      }

      return Promise.resolve({
        uri,
        name: resource.name,
        description: resource.description,
        mimeType: resource.mimeType,
        content: resource.content,
      });
    },
  }),
};
