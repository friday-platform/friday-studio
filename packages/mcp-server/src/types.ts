/**
 * Type definitions for MCP server mode and tool categorization
 */

export enum ServerMode {
  INTERNAL = "internal",
  PUBLIC = "public",
}

export enum ToolCategory {
  INTERNAL = "internal",
  PUBLIC = "public",
}

export interface ToolMetadata {
  category: ToolCategory;
  requiresWorkspaceContext: boolean;
  accessLevel: "admin" | "agent" | "public";
  description: string;
}

export interface ModeConfig {
  mode: ServerMode;
  serverName: string;
  allowedToolCategories: ToolCategory[];
  enableContextInjection: boolean;
}

export const MODE_CONFIGS: Record<ServerMode, ModeConfig> = {
  [ServerMode.INTERNAL]: {
    mode: ServerMode.INTERNAL,
    serverName: "atlas-internal",
    allowedToolCategories: [ToolCategory.INTERNAL, ToolCategory.PUBLIC],
    enableContextInjection: true,
  },
  [ServerMode.PUBLIC]: {
    mode: ServerMode.PUBLIC,
    serverName: "atlas-public",
    allowedToolCategories: [ToolCategory.PUBLIC],
    enableContextInjection: false,
  },
};
