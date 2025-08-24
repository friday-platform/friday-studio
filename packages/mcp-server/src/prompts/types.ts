/**
 * Shared types for MCP resources
 */

import type { Logger } from "../platform-server.ts";

/**
 * Context provided to all prompt handlers
 */
export interface PromptContext {
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
  return { content: [{ type: "text", text: JSON.stringify({ error: errorMessage }, null, 2) }] };
}

/**
 * Standard success response format for MCP tools
 */
export function createSuccessResponse(data: string): {
  messages: Array<{ role: "user"; content: { type: "text"; text: string } }>;
} {
  return { messages: [{ role: "user", content: { type: "text", text: data } }] };
}
