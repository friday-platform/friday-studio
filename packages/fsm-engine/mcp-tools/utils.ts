/**
 * Utility functions for MCP tool responses
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * Create a successful MCP response
 */
export function createSuccessResponse(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], isError: false };
}

/**
 * Create an error MCP response
 */
export function createErrorResponse(message: string, details?: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message, details }, null, 2) }],
    isError: true,
  };
}
