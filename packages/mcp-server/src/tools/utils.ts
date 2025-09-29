/** Shared utilities for MCP tools */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  CallToolResult,
  LoggingMessageNotification,
} from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "../platform-server.ts";

/** Build validated query params for library APIs */
export function buildLibraryQueryParams(options: {
  query?: string;
  type?: string[];
  tags?: string[];
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}): URLSearchParams {
  const params = new URLSearchParams();

  if (options.limit !== undefined && (options.limit < 1 || options.limit > 1000)) {
    throw new Error("Limit must be between 1 and 1000");
  }
  if (options.offset !== undefined && options.offset < 0) {
    throw new Error("Offset must be non-negative");
  }

  let sinceDate: Date | undefined;
  let untilDate: Date | undefined;

  if (options.since) {
    try {
      sinceDate = new Date(options.since);
      if (Number.isNaN(sinceDate.getTime())) {
        throw new Error("Invalid since date format");
      }
    } catch {
      throw new Error(
        "Invalid since date format. Use ISO 8601 format (e.g., 2024-01-15T10:30:00Z)",
      );
    }
  }

  if (options.until) {
    try {
      untilDate = new Date(options.until);
      if (Number.isNaN(untilDate.getTime())) {
        throw new Error("Invalid until date format");
      }
    } catch {
      throw new Error(
        "Invalid until date format. Use ISO 8601 format (e.g., 2024-01-15T10:30:00Z)",
      );
    }
  }

  if (sinceDate && untilDate && sinceDate >= untilDate) {
    throw new Error("'since' date must be before 'until' date");
  }

  if (options.query) {
    if (options.query.length > 1000) {
      throw new Error("Query string too long (max 1000 characters)");
    }
    params.set("q", options.query);
  }

  if (options.type && options.type.length > 0) {
    if (options.type.length > 20) {
      throw new Error("Too many type filters (max 20)");
    }
    params.set("type", options.type.map((t) => t.toLowerCase()).join(","));
  }

  if (options.tags && options.tags.length > 0) {
    if (options.tags.length > 50) {
      throw new Error("Too many tag filters (max 50)");
    }
    params.set("tags", options.tags.map((t) => t.toLowerCase()).join(","));
  }

  if (sinceDate) {
    params.set("since", sinceDate.toISOString());
  }
  if (untilDate) {
    params.set("until", untilDate.toISOString());
  }

  if (options.limit !== undefined) {
    params.set("limit", Math.floor(options.limit).toString());
  }
  if (options.offset !== undefined) {
    params.set("offset", Math.floor(options.offset).toString());
  }

  return params;
}

/** Create successful MCP response */
export function createSuccessResponse(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], isError: false };
}

/** Create error MCP response */
export function createErrorResponse(message: string, details?: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message, details }) }],
    isError: true,
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
