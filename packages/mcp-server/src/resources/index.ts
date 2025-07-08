/**
 * Resource registry for MCP server
 * Centralizes resource registration and management
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResourceContext } from "./types.ts";
import { registerWorkspaceReferenceResource } from "./workspace-reference.ts";

/**
 * Register all resources with the MCP server
 */
export function registerResources(server: McpServer, context: ResourceContext): void {
  registerWorkspaceReferenceResource(server, context);
  context.logger.info("Registered all resources with MCP server");
}
