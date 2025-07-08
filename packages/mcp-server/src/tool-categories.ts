/**
 * Tool categorization for MCP server mode support
 */

import { MODE_CONFIGS, ServerMode, ToolCategory, ToolMetadata } from "./types.ts";

/**
 * Internal tools - require workspace context, privileged access
 */
export const INTERNAL_TOOLS = [
  "library_store",
  "library_get",
  "library_list",
  "library_stats",
  "library_templates",
  "workspace_jobs_list",
  "workspace_jobs_describe",
  "workspace_sessions_list",
  "workspace_signals_list",
  "workspace_signals_trigger",
  "workspace_agents_list",
  "workspace_agents_describe",
] as const;

/**
 * Public tools - no workspace context required, read-only platform operations
 */
export const PUBLIC_TOOLS = [
  "workspace_list",
  "workspace_create",
  "workspace_delete",
  "workspace_describe",
  "session_describe",
  "session_cancel",
] as const;

/**
 * Tool metadata registry
 */
export const TOOL_METADATA: Record<string, ToolMetadata> = {
  // Internal tools
  library_store: {
    category: ToolCategory.INTERNAL,
    requiresWorkspaceContext: true,
    accessLevel: "agent",
    description: "Save content to the Atlas library with automatic workspace context injection",
  },
  library_get: {
    category: ToolCategory.INTERNAL,
    requiresWorkspaceContext: true,
    accessLevel: "agent",
    description: "Access specific library items with workspace-scoped access controls",
  },
  library_list: {
    category: ToolCategory.INTERNAL,
    requiresWorkspaceContext: true,
    accessLevel: "agent",
    description: "Browse and search library resources with workspace context filtering",
  },
  library_stats: {
    category: ToolCategory.INTERNAL,
    requiresWorkspaceContext: true,
    accessLevel: "agent",
    description: "View library usage metrics and statistics for workspace planning",
  },
  library_templates: {
    category: ToolCategory.INTERNAL,
    requiresWorkspaceContext: true,
    accessLevel: "agent",
    description: "Discover reusable templates available for workspace operations",
  },
  workspace_jobs_list: {
    category: ToolCategory.INTERNAL,
    requiresWorkspaceContext: true,
    accessLevel: "agent",
    description: "Discover automated tasks available in the current workspace environment",
  },
  workspace_jobs_describe: {
    category: ToolCategory.INTERNAL,
    requiresWorkspaceContext: true,
    accessLevel: "agent",
    description: "Examine job configuration and capabilities within workspace context",
  },
  workspace_sessions_list: {
    category: ToolCategory.INTERNAL,
    requiresWorkspaceContext: true,
    accessLevel: "agent",
    description: "Monitor execution sessions running in the current workspace",
  },
  session_describe: {
    category: ToolCategory.PUBLIC,
    requiresWorkspaceContext: false,
    accessLevel: "public",
    description: "Examine session details and execution state across all workspaces",
  },
  session_cancel: {
    category: ToolCategory.PUBLIC,
    requiresWorkspaceContext: false,
    accessLevel: "admin",
    description: "Terminate active execution session across all workspaces",
  },
  workspace_signals_list: {
    category: ToolCategory.INTERNAL,
    requiresWorkspaceContext: true,
    accessLevel: "agent",
    description: "View event triggers configured for the current workspace",
  },
  workspace_signals_trigger: {
    category: ToolCategory.INTERNAL,
    requiresWorkspaceContext: true,
    accessLevel: "agent",
    description: "Activate workspace event triggers to initiate automated workflows",
  },
  workspace_agents_list: {
    category: ToolCategory.INTERNAL,
    requiresWorkspaceContext: true,
    accessLevel: "agent",
    description: "Discover AI agents available within the current workspace environment",
  },
  workspace_agents_describe: {
    category: ToolCategory.INTERNAL,
    requiresWorkspaceContext: true,
    accessLevel: "agent",
    description: "Examine agent capabilities and configuration within workspace context",
  },

  // Public tools
  workspace_list: {
    category: ToolCategory.PUBLIC,
    requiresWorkspaceContext: false,
    accessLevel: "public",
    description: "Discover available Atlas workspace environments across the platform",
  },
  workspace_create: {
    category: ToolCategory.PUBLIC,
    requiresWorkspaceContext: false,
    accessLevel: "admin",
    description: "Establish new isolated workspace environment for project organization",
  },
  workspace_delete: {
    category: ToolCategory.PUBLIC,
    requiresWorkspaceContext: false,
    accessLevel: "admin",
    description: "Permanently remove workspace and all associated resources",
  },
  workspace_describe: {
    category: ToolCategory.PUBLIC,
    requiresWorkspaceContext: false,
    accessLevel: "public",
    description: "Retrieve comprehensive workspace details including configuration and status",
  },
};

/**
 * Get tools allowed for a specific mode
 */
export function getToolsForMode(mode: ServerMode): string[] {
  const config = MODE_CONFIGS[mode];
  const allowedTools: string[] = [];

  for (const [toolName, metadata] of Object.entries(TOOL_METADATA)) {
    if (config.allowedToolCategories.includes(metadata.category)) {
      allowedTools.push(toolName);
    }
  }

  return allowedTools;
}

/**
 * Check if a tool is allowed for a specific mode
 */
export function isToolAllowedForMode(toolName: string, mode: ServerMode): boolean {
  const metadata = TOOL_METADATA[toolName];
  if (!metadata) {
    return false;
  }

  const config = MODE_CONFIGS[mode];
  return config.allowedToolCategories.includes(metadata.category);
}
