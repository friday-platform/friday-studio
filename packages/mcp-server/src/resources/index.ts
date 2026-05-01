/**
 * Resource registry for MCP server
 *
 * Historical context: Resources were planned for serving static docs via MCP protocol.
 * This was superseded by the skills system (packages/system/agents/conversation/skills/).
 *
 * See: packages/mcp-server/TODOS.md for future resource plans.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResourceContext } from "./types.ts";

/**
 * Register all resources with the MCP server
 */
export function registerResources(_: McpServer, context: ResourceContext): void {
  context.logger.info("Registered all resources with MCP server");
}
