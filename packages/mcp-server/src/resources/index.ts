/**
 * Resource registry for MCP server
 * Centralizes resource registration and management
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResourceContext } from "./types.ts";

/**
 * Register all resources with the MCP server
 */
export function registerResources(_: McpServer, context: ResourceContext): void {
  context.logger.info("Registered all resources with MCP server");
}
