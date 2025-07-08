/**
 * Shared types for modular MCP tools
 */

import { z } from "zod/v4";
import type { Logger } from "../platform-server.ts";

/**
 * Context provided to all tool handlers
 */
export interface ToolContext {
  daemonUrl: string;
  logger: Logger;
}

/**
 * Standard tool handler interface that aligns with MCP SDK's registerTool pattern
 * The MCP SDK doesn't export a specific ToolDefinition type, but this interface
 * provides type safety while maintaining compatibility with the SDK.
 */
export interface ToolHandler<TSchema extends z.ZodObject<any> = z.ZodObject<any>> {
  name: string;
  description: string;
  inputSchema: TSchema;
  handler: (args: z.infer<TSchema>, context: ToolContext) => Promise<{
    content: Array<{
      type: "text";
      text: string;
    }>;
  }>;
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
