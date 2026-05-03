/** Shared utilities for MCP tools */

import type { Artifact } from "@atlas/core/artifacts";
import type { Logger } from "@atlas/logger";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  CallToolResult,
  LoggingMessageNotification,
} from "@modelcontextprotocol/sdk/types.js";

/**
 * Strip internal storage references from artifact data before returning
 * to agents. Agents reference artifacts by ID; the SHA-256 contentRef is
 * an internal Object Store name and should not leak.
 */
export function stripArtifactFilePaths(artifact: Artifact) {
  if (artifact.data.type !== "file") return artifact;
  const { contentRef: _, ...fileData } = artifact.data;
  return { ...artifact, data: fileData };
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
