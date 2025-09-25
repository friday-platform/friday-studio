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
 * Standard success response format for MCP tools
 */
export function createSuccessResponse(data: string): {
  messages: Array<{ role: "user"; content: { type: "text"; text: string } }>;
} {
  return { messages: [{ role: "user", content: { type: "text", text: data } }] };
}
