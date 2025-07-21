/**
 * Atlas Tool Registry - AI SDK Compatible
 */

import { filesystemTools } from "./filesystem.ts";
import { workspaceTools } from "./workspace.ts";
import { sessionTools } from "./session.ts";
import { jobTools } from "./job.ts";
import { signalTools } from "./signal.ts";
import { agentTools } from "./agent.ts";
import { libraryTools } from "./library.ts";
import { draftTools } from "./draft.ts";
import { systemTools } from "./system.ts";
import { conversationTools } from "./conversation.ts";
import { Tool } from "ai";
import { Tools } from "./types.ts";

/**
 * Tool categories available in the registry
 */
export type ToolCategory =
  | "filesystem"
  | "workspace"
  | "session"
  | "job"
  | "signal"
  | "agent"
  | "library"
  | "draft"
  | "system"
  | "conversation"
  | "all";

/**
 * Atlas Tool Registry Class
 *
 * Manages and provides access to all Atlas tools organized by category
 */
export class AtlasToolRegistry {
  private readonly toolCategories: { [key in ToolCategory]?: Tools };
  constructor(tools: { [key in ToolCategory]?: Tools }) {
    this.toolCategories = tools;
  }

  /**
   * Get all tools across all categories
   */
  getAllTools(): Tools {
    const allTools: Tools = {};

    for (const tools of Object.values(this.toolCategories)) {
      Object.assign(allTools, tools);
    }

    return allTools;
  }

  /**
   * Get tools by category
   */
  getToolsByCategory(category: ToolCategory): Tools {
    if (category === "all") {
      return this.getAllTools();
    }

    if (!(category in this.toolCategories)) {
      throw new Error(`Unknown tool category: ${category}`);
    }

    return this.toolCategories[category] ?? {};
  }

  /**
   * Get available tool categories
   */
  getAvailableCategories(): ToolCategory[] {
    // @ts-expect-error tool categories are hard-coded and it's fine to narrow based on those.
    return Object.keys(this.toolCategories);
  }

  /**
   * Get tool by name
   */
  getToolByName(toolName: string): Tool | null {
    for (const tools of Object.values(this.toolCategories)) {
      if (tools[toolName]) {
        return tools[toolName];
      }
    }
    return null;
  }

  /**
   * Check if tool exists
   */
  hasTools(toolName: string): boolean {
    return this.getToolByName(toolName) !== null;
  }

  /**
   * Get tool names by category
   */
  getToolNamesByCategory(category: ToolCategory): string[] {
    const tools = this.getToolsByCategory(category);
    return Object.keys(tools);
  }

  /**
   * Get all tool names
   */
  getAllToolNames(): string[] {
    return this.getToolNamesByCategory("all");
  }

  /**
   * Get tools count by category
   */
  getToolsCountByCategory(category: ToolCategory): number {
    return this.getToolNamesByCategory(category).length;
  }

  /**
   * Get registry summary
   */
  getSummary(): {
    totalTools: number;
    categories: Record<string, number>;
  } {
    const summary = {
      totalTools: this.getAllToolNames().length,
      categories: {} as Record<string, number>,
    };

    for (const category of this.getAvailableCategories()) {
      summary.categories[category] = this.getToolsCountByCategory(category);
    }

    return summary;
  }
}

// Create a default registry instance for convenience
const defaultRegistry = new AtlasToolRegistry(
  {
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
  },
);

/**
 * Convenience function to get the default registry instance
 */
export function getAtlasToolRegistry(): AtlasToolRegistry {
  return defaultRegistry;
}

/**
 * Export all tools in a single object (for backward compatibility)
 */
export const atlasTools = defaultRegistry.getAllTools();

/**
 * Export individual category tools for selective imports
 */
export {
  agentTools,
  conversationTools,
  draftTools,
  filesystemTools,
  jobTools,
  libraryTools,
  sessionTools,
  signalTools,
  systemTools,
  workspaceTools,
};
