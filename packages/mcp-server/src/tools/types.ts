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
 * Standard error response format for MCP tools
 */
function createErrorResponse(error: unknown): { content: Array<{ type: "text"; text: string }> } {
  const errorMessage = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: JSON.stringify({ error: errorMessage }, null, 2) }] };
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
  return async (
    params: { method: string; params: { level: string; data: unknown } },
    silent = false,
  ) => {
    try {
      const notification: LoggingMessageNotification = {
        method: "notifications/message",
        params: {
          level: params.params.level as
            | "debug"
            | "info"
            | "notice"
            | "warning"
            | "error"
            | "critical"
            | "alert"
            | "emergency",
          logger: "atlas-platform",
          data: params.params.data,
        },
      };

      // Use the server's sendLoggingMessage if available
      if (typeof server.sendLoggingMessage === "function") {
        await server.sendLoggingMessage(notification.params);
      } else if (!silent) {
        // Fallback: log to server logger (sanitize content for logging)
        const sanitizedParams = sanitizeNotificationForLogging(notification.params);
        logger.info("Notification (streaming fallback)", sanitizedParams);
      }
    } catch (error) {
      // Sanitize params in error logging to avoid content leakage
      const sanitizedParams = sanitizeNotificationForLogging(params);
      logger.error("Failed to send notification", { error, params: sanitizedParams });
    }
  };
}

/**
 * Sanitize notification parameters for logging to prevent content leakage
 */
function sanitizeNotificationForLogging(params: unknown): unknown {
  if (typeof params !== "object" || params === null) {
    return params;
  }

  const paramsObj = params;

  // If this looks like notification data with content, sanitize it
  if (paramsObj.data && typeof paramsObj.data === "string") {
    try {
      const parsedData = JSON.parse(paramsObj.data);
      if (parsedData && typeof parsedData === "object") {
        // Check if this is a chunk notification with content
        if (parsedData.type === "library_content_chunk" && parsedData.content) {
          const sanitized = { ...parsedData };
          sanitized.content = `[CONTENT REDACTED - ${parsedData.content?.length || 0} chars]`;
          return { ...paramsObj, data: JSON.stringify(sanitized) };
        }
      }
    } catch {
      // If JSON parsing fails, just return original data
      return params;
    }
  }

  return params;
}
