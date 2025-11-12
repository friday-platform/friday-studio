/**
 * @atlas/mcp - Core MCP functionality for Atlas
 *
 * This package provides the core MCP (Model Context Protocol) management
 * functionality for Atlas, including server lifecycle management, configuration
 * resolution, proxy functionality, and remote adapter functionality.
 */

// Re-export types that consumers might need
export type { MCPServerConfig } from "./src/manager.ts";
export { MCPManager, MCPServerConfigSchema, mcpManager } from "./src/manager.ts";
export type {
  AgentConfig,
  AtlasConfig,
  MCPServerOverrides,
  SessionContext,
  WorkspaceConfig,
} from "./src/registry.ts";
export { MCPServerRegistry } from "./src/registry.ts";
