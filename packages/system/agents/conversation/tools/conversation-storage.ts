/**
 * Conversation Storage Tool - SDK Architecture
 * Adapted from packages/tools/src/internal/conversation.ts
 *
 * Manages conversation history using daemon's storage API
 */

import { tool } from "ai";
import { z } from "zod/v4";
import { createAtlasClient } from "@atlas/oapi-client";

// Helper to safely extract error message from unknown error
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export const conversationStorageTool = tool({
  description:
    "Manage conversation history using stream_id as key. Supports storing, retrieving, and deleting conversation data.",
  inputSchema: z
    .object({
      operation: z
        .enum(["store", "retrieve", "delete"])
        .describe("The operation to perform on conversation storage"),
      streamId: z
        .string()
        .describe("The stream ID to operate on"),
      message: z
        .object({
          role: z.enum(["user", "assistant"]),
          content: z.string(),
        })
        .optional()
        .describe("The message to store (required for store operation)"),
      metadata: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Additional metadata to store with the message"),
    })
    .refine(
      (data) => {
        // Validate required fields based on operation
        if (data.operation === "store") {
          return data.message !== undefined;
        }
        return true;
      },
      {
        message: "message is required for store operation",
      },
    ),
  execute: async ({ operation, streamId, message, metadata }) => {
    try {
      const client = createAtlasClient();

      switch (operation) {
        case "store": {
          if (!message) {
            throw new Error("message is required for store operation");
          }
          const response = await client.POST("/api/conversation-storage/{streamId}", {
            params: { path: { streamId } },
            body: {
              message,
              metadata,
              timestamp: new Date().toISOString(),
            },
          });

          if (response.error) {
            throw new Error(`API error (${response.response.status}): ${response.error.error}`);
          }

          return {
            success: true,
            operation,
            streamId,
            result: response.data,
          };
        }

        case "retrieve": {
          const response = await client.GET("/api/conversation-storage/{streamId}", {
            params: { path: { streamId } },
          });

          if (response.error) {
            throw new Error(`API error (${response.response.status}): ${response.error.error}`);
          }

          return {
            success: true,
            operation,
            streamId,
            result: response.data,
          };
        }

        case "delete": {
          const response = await client.DELETE("/api/conversation-storage/{streamId}", {
            params: { path: { streamId } },
          });

          if (response.error) {
            throw new Error(`API error (${response.response.status}): ${response.error.error}`);
          }

          return {
            success: true,
            operation,
            streamId,
            result: response.data,
          };
        }

        default:
          throw new Error(`Unknown operation: ${operation}`);
      }
    } catch (error) {
      throw new Error(
        `Failed to manage conversation storage: ${getErrorMessage(error)}`,
      );
    }
  },
});
