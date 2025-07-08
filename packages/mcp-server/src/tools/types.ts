/**
 * Shared types for modular MCP tools
 */

import type { Logger } from "../platform-server.ts";

/**
 * Context provided to all tool handlers
 */
export interface ToolContext {
  daemonUrl: string;
  logger: Logger;
}

/**
 * Standard error response format for MCP tools
 */
export function createErrorResponse(error: unknown): {
  content: Array<{ type: "text"; text: string }>;
} {
  const errorMessage = error instanceof Error ? error.message : String(error);
  return {
    content: [{
      type: "text",
      text: JSON.stringify({ error: errorMessage }, null, 2),
    }],
  };
}

/**
 * Standard success response format for MCP tools
 */
export function createSuccessResponse(data: unknown): {
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    content: [{
      type: "text",
      text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
    }],
  };
}
