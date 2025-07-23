/**
 * Atlas Resource Tools - AI SDK Compatible
 */

import { z } from "zod/v4";
import { tool } from "ai";
import { agentTools } from "./agent.ts";
import { conversationTools } from "./conversation.ts";
import { draftTools } from "./draft.ts";
import { filesystemTools } from "./filesystem.ts";
import { jobTools } from "./job.ts";
import { libraryTools } from "./library.ts";
import { sessionTools } from "./session.ts";
import { signalTools } from "./signal.ts";
import { systemTools } from "./system.ts";
import { workspaceTools } from "./workspace.ts";

/**
 * Generate tools content using registry-like methods without circular dependencies
 */
function generateToolsContentFromRegistry(): string {
  // Create local tool registry structure
  const toolCategories = {
    filesystem: filesystemTools,
    workspace: workspaceTools,
    session: sessionTools,
    job: jobTools,
    signal: signalTools,
    agent: agentTools,
    library: libraryTools,
    draft: draftTools,
    system: systemTools,
    conversation: conversationTools,
  };

  // Get available categories (mimics registry.getAvailableCategories())
  const availableCategories = Object.keys(toolCategories);

  // Category display names and descriptions (derived from registry patterns)
  const getCategoryDisplayName = (category: string): string => {
    const displayNames: Record<string, string> = {
      filesystem: "Filesystem Tools",
      workspace: "Workspace Management Tools",
      session: "Session Control Tools",
      job: "Job Management Tools",
      signal: "Signal Management Tools",
      agent: "Agent Management Tools",
      library: "Library Tools",
      draft: "Draft Management Tools",
      system: "System Integration Tools",
      conversation: "Conversation Tools",
    };
    return displayNames[category] ||
      `${category.charAt(0).toUpperCase()}${category.slice(1)} Tools`;
  };

  const getCategoryDescription = (category: string): string => {
    const descriptions: Record<string, string> = {
      filesystem: "File system operations for reading, writing, and searching files",
      workspace: "Workspace lifecycle operations for managing Atlas workspaces",
      session: "Session lifecycle management for controlling workspace execution",
      job: "Job configuration and monitoring within workspaces",
      signal: "Signal configuration and triggering for workspace automation",
      agent: "Agent configuration and monitoring within workspaces",
      library: "Knowledge and template management for reusable components",
      draft: "Configuration drafting and testing before workspace deployment",
      system: "External system integrations and command execution",
      conversation: "Real-time communication and conversation management",
    };
    return descriptions[category] || `Tools for ${category} operations`;
  };

  // Generate tools content (mimics registry methods)
  let content = "### Currently Available Tools\n\n";
  content += "Atlas provides these built-in tools organized by functionality:\n\n";

  // Generate category sections (mimics registry.getToolsByCategory())
  for (const category of availableCategories) {
    const tools = toolCategories[category as keyof typeof toolCategories];
    const displayName = getCategoryDisplayName(category);
    const description = getCategoryDescription(category);

    content += `**${displayName}** - ${description}\n\n`;

    // List tools in category (mimics Object.entries(tools))
    for (const [toolName, tool] of Object.entries(tools)) {
      content += `- \`${toolName}\` - ${tool.description}\n`;
    }
    content += "\n";
  }

  // Add intent-based guidance (derived from common automation patterns)
  content += "### Tool Selection by Intent\n\n";
  content += "Choose tools based on what you want to accomplish:\n\n";

  const intentGuidance = {
    "Web Monitoring": [
      "atlas_fetch - Scrape websites and APIs",
      "atlas_bash - Run curl or specialized scraping tools",
      "atlas_notify_email - Send alerts when changes detected",
      "atlas_library_store - Remember previous states for comparison",
    ],
    "Data Processing": [
      "atlas_read - Load data files",
      "atlas_glob - Find all data files matching patterns",
      "atlas_write - Save processed results",
      "atlas_library_store - Cache processed data",
    ],
    "Code Analysis": [
      "atlas_grep - Search code for patterns",
      "atlas_read - Analyze specific files",
      "atlas_bash - Run linters, tests, or build tools",
      "atlas_notify_email - Report analysis results",
    ],
    "Workflow Automation": [
      "atlas_workspace_jobs_list - Monitor job status",
      "atlas_session_describe - Check execution details",
      "atlas_bash - Execute automated tasks",
      "atlas_stream_reply - Provide real-time updates",
    ],
    "Development & Testing": [
      "atlas_workspace_draft_create - Create test configurations",
      "atlas_workspace_draft_validate - Verify configurations",
      "atlas_bash - Run tests and builds",
      "atlas_publish_draft_to_workspace - Deploy when ready",
    ],
    "Content Management": [
      "atlas_library_list - Browse available content",
      "atlas_library_get - Retrieve specific content",
      "atlas_read - Analyze content files",
      "atlas_write - Generate new content",
    ],
  };

  for (const [intent, tools] of Object.entries(intentGuidance)) {
    content += `**${intent}**:\n`;
    for (const tool of tools) {
      content += `- ${tool}\n`;
    }
    content += "\n";
  }

  return content;
}

const ATLAS_RESOURCES = {
  "atlas://guides/workspace-creation": {
    name: "Atlas Workspace Creation Guide",
    description: "Comprehensive guide for creating Atlas workspaces with patterns and examples",
    mimeType: "text/markdown",
    filePath: new URL("./resources/workspace-creation-guide.md", import.meta.url).pathname,
  },
  "atlas://reference/workspace": {
    name: "Atlas Workspace Reference",
    description: "Complete YAML reference for workspace configuration",
    mimeType: "text/yaml",
    filePath: new URL("./resources/workspace-reference.yml", import.meta.url).pathname,
  },
} as const;

export const resourceTools = {
  read_atlas_resource: tool({
    description:
      `Read an Atlas documentation resource by URI. This tool provides access to comprehensive guides and documentation stored as Atlas resources.

Available resources:
- atlas://guides/workspace-creation - Comprehensive workspace creation guide with patterns and examples
- atlas://reference/workspace - Workspace YAML reference documentation

Use this tool to access detailed technical documentation when helping users with workspace creation, configuration, or troubleshooting.`,
    inputSchema: z.object({
      uri: z.string().describe(
        "The resource URI to read (e.g., atlas://guides/workspace-creation)",
      ),
    }),
    execute: async ({ uri }) => {
      const resource = ATLAS_RESOURCES[uri as keyof typeof ATLAS_RESOURCES];

      if (!resource) {
        const availableUris = Object.keys(ATLAS_RESOURCES).join(", ");
        throw new Error(`Resource not found: ${uri}. Available resources: ${availableUris}`);
      }

      try {
        let content = await Deno.readTextFile(resource.filePath);

        // For workspace creation guide, replace tools placeholder with generated content
        if (uri === "atlas://guides/workspace-creation") {
          const toolsContent = generateToolsContentFromRegistry();
          content = content.replace("{{AVAILABLE_TOOLS}}", toolsContent);
        }

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
  }),
};
