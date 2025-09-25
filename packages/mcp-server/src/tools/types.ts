/**
 * Shared types for modular MCP tools
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { LoggingMessageNotification } from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "../platform-server.ts";

/**
 * Context provided to all tool handlers
 */
export interface ToolContext {
  daemonUrl: string;
  logger: Logger;
  server: McpServer;
}

/**
 * Standard success response format for MCP tools
 */
export function createSuccessResponse(data: unknown): {
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    content: [
      { type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) },
    ],
  };
}

/**
 * Create a sendNotification function for tools that can send logging messages
 */
export function createSendNotification(server: McpServer, logger: Logger) {
  return async (params: {
    method: string;
    params: {
      level: "error" | "debug" | "info" | "notice" | "warning" | "critical" | "alert" | "emergency";
      data: unknown;
    };
  }) => {
    try {
      const notification: LoggingMessageNotification = {
        method: "notifications/message",
        params: { level: params.params.level, logger: "atlas-platform", data: params.params.data },
      };
      await server.sendLoggingMessage(notification.params);
    } catch (error) {
      logger.error("Failed to send notification", { error });
    }
  };
}
