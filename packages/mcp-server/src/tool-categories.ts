/**
 * Tool categorization for MCP server mode support
 */

import { ToolCategory, ToolMetadata } from "./types.ts";

/**
 * Internal tools - require workspace context, privileged access
 */
export const INTERNAL_TOOLS = [
  "library_store",
  "library_get",
  "library_list",
  "library_search",
  "library_stats",
  "library_templates",
  "workspace_jobs_list",
  "workspace_jobs_describe",
  "workspace_sessions_list",
  "workspace_sessions_describe",
  "workspace_sessions_cancel",
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
    description: "Store library items with automatic workspace context",
  },
  library_get: {
    category: ToolCategory.INTERNAL,
    requiresWorkspaceContext: true,
    accessLevel: "agent",
    description: "Retrieve library items with workspace filtering",
  },
  library_list: {
    category: ToolCategory.INTERNAL,
    requiresWorkspaceContext: true,
    accessLevel: "agent",
    description: "List library items with workspace filtering",
  },
  library_search: {
    category: ToolCategory.INTERNAL,
    requiresWorkspaceContext: true,
    accessLevel: "agent",
    description: "Search within workspace library",
  },
  library_stats: {
    category: ToolCategory.INTERNAL,
    requiresWorkspaceContext: true,
    accessLevel: "agent",
    description: "Workspace library usage statistics",
  },
  library_templates: {
    category: ToolCategory.INTERNAL,
    requiresWorkspaceContext: true,
    accessLevel: "agent",
    description: "Available library templates for workspace",
  },
  workspace_jobs_list: {
    category: ToolCategory.INTERNAL,
    requiresWorkspaceContext: true,
    accessLevel: "agent",
    description: "List jobs in current workspace",
  },
  workspace_jobs_describe: {
    category: ToolCategory.INTERNAL,
    requiresWorkspaceContext: true,
    accessLevel: "agent",
    description: "Describe specific job in workspace",
  },
  workspace_sessions_list: {
    category: ToolCategory.INTERNAL,
    requiresWorkspaceContext: true,
    accessLevel: "agent",
    description: "List sessions in current workspace",
  },
  workspace_sessions_describe: {
    category: ToolCategory.INTERNAL,
    requiresWorkspaceContext: true,
    accessLevel: "agent",
    description: "Describe specific session in workspace",
  },
  workspace_sessions_cancel: {
    category: ToolCategory.INTERNAL,
    requiresWorkspaceContext: true,
    accessLevel: "agent",
    description: "Cancel running session in workspace",
  },
  workspace_signals_list: {
    category: ToolCategory.INTERNAL,
    requiresWorkspaceContext: true,
    accessLevel: "agent",
    description: "List signals in current workspace",
  },
  workspace_signals_trigger: {
    category: ToolCategory.INTERNAL,
    requiresWorkspaceContext: true,
    accessLevel: "agent",
    description: "Trigger signal in current workspace",
  },
  workspace_agents_list: {
    category: ToolCategory.INTERNAL,
    requiresWorkspaceContext: true,
    accessLevel: "agent",
    description: "List agents in current workspace",
  },
  workspace_agents_describe: {
    category: ToolCategory.INTERNAL,
    requiresWorkspaceContext: true,
    accessLevel: "agent",
    description: "Describe specific agent in workspace",
  },

  // Public tools
  workspace_list: {
    category: ToolCategory.PUBLIC,
    requiresWorkspaceContext: false,
    accessLevel: "public",
    description: "List all workspaces via daemon API",
  },
  workspace_create: {
    category: ToolCategory.PUBLIC,
    requiresWorkspaceContext: false,
    accessLevel: "admin",
    description: "Create new workspace via daemon API",
  },
  workspace_delete: {
    category: ToolCategory.PUBLIC,
    requiresWorkspaceContext: false,
    accessLevel: "admin",
    description: "Delete workspace via daemon API",
  },
  workspace_describe: {
    category: ToolCategory.PUBLIC,
    requiresWorkspaceContext: false,
    accessLevel: "public",
    description: "Describe workspace via daemon API",
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

// Import ServerMode and MODE_CONFIGS from types.ts
import { MODE_CONFIGS, ServerMode } from "./types.ts";
