/**
 * @atlas/mcp - Core MCP functionality for Atlas
 *
 * This package provides the core MCP (Model Context Protocol) management
 * functionality for Atlas, including server lifecycle management, configuration
 * resolution, and remote adapter functionality.
 */

export { MCPManager, MCPServerConfigSchema } from "./src/manager.ts";
export { MCPServerRegistry } from "./src/registry.ts";
export { WorkspaceMCPConfigurationService } from "./src/configuration-service.ts";
export { MCPAdapter } from "./src/adapters/mcp-adapter.ts";

// Re-export types that consumers might need
export type { MCPServerConfig } from "./src/manager.ts";

export type {
  AgentConfig,
  AtlasConfig,
  MCPServerOverrides,
  SessionContext,
  WorkspaceConfig,
} from "./src/registry.ts";

export type { MCPConfigurationService } from "./src/configuration-service.ts";
