/**
 * @atlas/mcp - Ephemeral MCP client for Atlas
 *
 * Connects to MCP servers, fetches tools, returns a dispose callback.
 * No pooling, no sharing, no ref counting.
 *
 * @module
 */

export type { CreateMCPToolsOptions, MCPToolsResult } from "./src/create-mcp-tools.ts";
export { createMCPTools } from "./src/create-mcp-tools.ts";
