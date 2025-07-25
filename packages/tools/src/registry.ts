/**
 * Atlas Tool Registry - AI SDK Compatible
 */

import {
  agentTools,
  conversationTools,
  filesystemTools,
  jobTools,
  libraryTools,
  resourceTools,
  sessionTools,
  signalTools,
  systemTools,
  workspaceTools,
} from "./internal/index.ts";
import {
  createMCPToolsAdapter,
  type MCPToolsAdapterConfig,
} from "./external-adapters/mcp-tools-adapter.ts";
import { Tool, tool } from "ai";
import { z } from "zod/v4";
import { AgentContext, ContextInjectionResult, ToolContextRequirements, Tools } from "./types.ts";

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
  | "system"
  | "conversation"
  | "resource"
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
      if (tools?.[toolName]) {
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

  /**
   * Get tools from MCP servers as AI SDK Tools array
   * Automatically calls tools/list on each server and returns Tools array
   */
  async getMCPTools(config: MCPToolsAdapterConfig): Promise<Tool[]> {
    const adapter = createMCPToolsAdapter();
    const result = await adapter.getTools(config);

    if (!result.success) {
      throw new Error(`Failed to get MCP tools: ${result.error.message}`);
    }

    return [...result.data]; // Convert to mutable array for registry compatibility
  }

  /**
   * Get combined Atlas tools and MCP tools
   * Returns both static Atlas tools and dynamic MCP tools
   */
  async getAllToolsWithMCP(mcpConfig?: MCPToolsAdapterConfig): Promise<{
    atlasTools: Tools;
    mcpTools: Tool[];
    combined: Tools;
  }> {
    const atlasTools = this.getAllTools();
    const mcpTools = mcpConfig ? await this.getMCPTools(mcpConfig) : [];

    // Create combined object with MCP tools using their names
    const combined: Tools = { ...atlasTools };
    for (const tool of mcpTools) {
      // Use tool description as key if available, otherwise generate one
      const toolKey = this.extractToolName(tool) || `mcp_tool_${Object.keys(combined).length}`;
      combined[toolKey] = tool;
    }

    return {
      atlasTools,
      mcpTools,
      combined,
    };
  }

  /**
   * Context-dependent tools configuration
   * Maps tool names to their context injection requirements
   */
  private getContextRequirements(): ToolContextRequirements {
    return {
      "atlas_stream_reply": {
        injectableFields: ["streamId"],
        supportsContextInjection: true,
      },
      // Add more context-dependent tools here as needed
    };
  }

  /**
   * Get tools with context injection
   * When context is provided, injects context into tools and removes context parameters
   * When context is null/undefined, returns standard tools with context parameters
   */
  getToolsWithContext(category: ToolCategory, context: AgentContext): Tools {
    const tools = this.getToolsByCategory(category);
    return this.injectContext(tools, context);
  }

  /**
   * Get all tools with context injection
   */
  getAllToolsWithContext(context: AgentContext): Tools {
    const tools = this.getAllTools();
    return this.injectContext(tools, context);
  }

  /**
   * Inject context into tools that support it
   * Returns new tools object with context-injected versions
   */
  private injectContext(tools: Tools, context: AgentContext): Tools {
    const contextRequirements = this.getContextRequirements();
    const result: Tools = {};

    for (const [toolName, tool] of Object.entries(tools)) {
      if (contextRequirements[toolName]?.supportsContextInjection) {
        const injectionResult = this.injectContextIntoTool(
          tool,
          toolName,
          context,
          contextRequirements[toolName],
        );
        result[toolName] = injectionResult.tool;
      } else {
        // Non-context tools pass through unchanged
        result[toolName] = tool;
      }
    }

    return result;
  }

  /**
   * Inject context into a specific tool
   */
  private injectContextIntoTool(
    originalTool: Tool,
    toolName: string,
    context: AgentContext,
    requirements: { injectableFields: (keyof AgentContext)[] },
  ): ContextInjectionResult {
    // Check if any required context is actually provided (non-null, non-undefined)
    const availableContext: Record<string, any> = {};
    let hasValidContext = false;

    for (const field of requirements.injectableFields) {
      const value = context[field];
      if (value !== null && value !== undefined) {
        availableContext[field] = value;
        hasValidContext = true;
      }
    }

    // If no valid context provided, return original tool
    if (!hasValidContext) {
      return {
        tool: originalTool,
        contextInjected: false,
        injectedFields: [],
      };
    }

    // Create context-injected tool (currently only handles streamId for atlas_stream_reply)
    if (toolName === "atlas_stream_reply" && availableContext.streamId) {
      const contextAwareTool = this.createContextAwareStreamReplyTool(availableContext.streamId);
      return {
        tool: contextAwareTool,
        contextInjected: true,
        injectedFields: ["streamId"],
      };
    }

    // Fallback to original tool if context injection not implemented for this tool
    return {
      tool: originalTool,
      contextInjected: false,
      injectedFields: [],
    };
  }

  /**
   * Create context-aware version of atlas_stream_reply tool
   * This replaces the factory function pattern with registry-managed context injection
   */
  private createContextAwareStreamReplyTool(streamId: string): Tool {
    return tool({
      description:
        "Send a streaming reply to the user. The stream ID is automatically provided via context.",
      inputSchema: z.object({
        content: z.string().describe("The content to send as a streaming reply"),
        metadata: z.record(z.string(), z.unknown()).optional().describe(
          "Optional metadata to include with the reply",
        ),
      }),
      execute: async ({ content, metadata }) => {
        if (!streamId) {
          throw new Error(
            "streamId is required for atlas_stream_reply but was not provided in the context",
          );
        }

        // Get the original tool and call it with injected streamId
        const originalTool = this.getToolByName("atlas_stream_reply");
        if (!originalTool?.execute) {
          throw new Error("atlas_stream_reply tool execute function not found");
        }

        return await originalTool.execute({
          streamId,
          content,
          metadata,
        }, {
          toolCallId: crypto.randomUUID(),
          messages: [],
        });
      },
    });
  }

  /**
   * Extract tool name from AI SDK Tool (best effort)
   */
  private extractToolName(tool: Tool): string | null {
    // Try to extract name from description or other properties
    if (tool.description) {
      // Look for patterns like "tool_name: description" or "tool_name - description"
      const match = tool.description.match(/^([a-zA-Z_][a-zA-Z0-9_]*)[:\-\s]/);
      if (match && match[1]) {
        return match[1];
      }
    }

    // If tool has a name property (non-standard but possible)
    if ("name" in tool && typeof tool.name === "string") {
      return tool.name;
    }

    return null;
  }
}

// Create a default registry instance for convenience
const defaultRegistry = new AtlasToolRegistry({
  filesystem: filesystemTools,
  workspace: workspaceTools,
  session: sessionTools,
  job: jobTools,
  signal: signalTools,
  agent: agentTools,
  library: libraryTools,
  system: systemTools,
  conversation: conversationTools,
  resource: resourceTools,
});

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
  filesystemTools,
  jobTools,
  libraryTools,
  resourceTools,
  sessionTools,
  signalTools,
  systemTools,
  workspaceTools,
};

/**
 * Export external adapter functionality
 */
export { type MCPToolsAdapterConfig } from "./external-adapters/index.ts";
