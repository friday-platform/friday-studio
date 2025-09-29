import { createAtlasClient } from "@atlas/oapi-client";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../types.ts";
import { createErrorResponse, createSendNotification, createSuccessResponse } from "../utils.ts";

export function registerLibraryGetStreamTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "atlas_library_get_stream",
    {
      description:
        "Retrieve a library item with streaming content delivery. Large content is sent progressively via notifications, providing real-time updates as data is processed. Use this for better user experience with large library items.",
      inputSchema: {
        itemId: z
          .string()
          .describe("Unique identifier of the library item to retrieve (obtain from library_list)"),
        includeContent: z
          .boolean()
          .default(true)
          .describe(
            "Whether to include the full content/data of the item with progressive streaming",
          ),
        chunkSize: z
          .number()
          .min(100)
          .max(10000)
          .default(2000)
          .describe("Size of each content chunk for streaming (bytes, default: 2000)"),
      },
    },
    async ({ itemId, includeContent = true, chunkSize = 2000 }) => {
      const sendNotification = createSendNotification(ctx.server, ctx.logger);
      ctx.logger.info("MCP library_get_stream called", { itemId, includeContent, chunkSize });

      // Input validation
      if (!itemId || typeof itemId !== "string" || itemId.trim().length === 0) {
        throw new Error("itemId is required and must be a non-empty string");
      }

      try {
        // Send initial notification
        if (sendNotification) {
          await sendNotification({
            method: "notifications/message",
            params: {
              level: "info",
              data: JSON.stringify({
                type: "library_stream_started",
                itemId,
                timestamp: new Date().toISOString(),
                message: "Starting library item retrieval...",
              }),
            },
          });
        }

        // First, get metadata
        const client = createAtlasClient();
        const metadataResponse = await client.GET("/api/library/{itemId}", {
          params: { path: { itemId } },
        });
        if (metadataResponse.error) {
          ctx.logger.error("Failed to get library stream", {
            itemId,
            error: metadataResponse.error,
          });
          return createErrorResponse(
            `Failed to get library stream for item '${itemId}': ${metadataResponse.error.error || metadataResponse.response.statusText}`,
          );
        }
        const libraryItem = metadataResponse.data;

        // Send metadata notification
        if (sendNotification) {
          await sendNotification({
            method: "notifications/message",
            params: {
              level: "info",
              data: JSON.stringify({
                type: "library_metadata",
                itemId,
                metadata: libraryItem,
                timestamp: new Date().toISOString(),
                message: `Found library item: ${libraryItem.item.name}`,
              }),
            },
          });
        }

        if (!includeContent) {
          // Return metadata only
          return createSuccessResponse({
            item: libraryItem,
            source: "daemon_api",
            streaming: false,
            timestamp: new Date().toISOString(),
          });
        }

        // Get content
        const contentResponse = await client.GET("/api/library/{itemId}", {
          params: { path: { itemId }, query: { content: "true" } },
        });
        if (contentResponse.error) {
          ctx.logger.error("Failed to get library stream content", {
            itemId,
            error: contentResponse.error,
          });
          return createErrorResponse(
            `Failed to get library stream content for item '${itemId}': ${contentResponse.error.error || contentResponse.response.statusText}`,
          );
        }
        const libraryItemWithContent = contentResponse.data;

        const content = libraryItemWithContent.content;
        const totalSize = content?.length ?? 0;

        // Send content size notification
        if (sendNotification) {
          await sendNotification({
            method: "notifications/message",
            params: {
              level: "info",
              data: JSON.stringify({
                type: "library_content_info",
                itemId,
                totalSize,
                chunkSize,
                totalChunks: Math.ceil(totalSize / chunkSize),
                timestamp: new Date().toISOString(),
                message: `Content size: ${totalSize} bytes, will stream in ${Math.ceil(
                  totalSize / chunkSize,
                )} chunks`,
              }),
            },
          });
        }

        // Stream content in chunks if it's large
        const shouldStream = totalSize > chunkSize && !!sendNotification;

        if (shouldStream) {
          // Actually stream the content in chunks
          const totalChunks = Math.ceil(totalSize / chunkSize);

          for (let i = 0; i < totalChunks; i++) {
            const start = i * chunkSize;
            const end = Math.min(start + chunkSize, totalSize);
            const chunk = content?.slice(start, end) ?? "";
            const chunkNumber = i + 1;

            // Send chunk via notification silently (no log line per chunk)
            await sendNotification({
              method: "notifications/message",
              params: {
                level: "info",
                data: JSON.stringify({
                  type: "library_content_chunk",
                  itemId,
                  chunkNumber,
                  totalChunks,
                  chunkSize: chunk.length,
                  content: chunk,
                  isLastChunk: chunkNumber === totalChunks,
                  timestamp: new Date().toISOString(),
                  message: `Chunk ${chunkNumber}/${totalChunks} (${chunk.length} bytes)`,
                }),
              },
            });

            // Small delay between chunks to allow processing
            if (chunkNumber < totalChunks) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }

          // Send completion notification
          await sendNotification({
            method: "notifications/message",
            params: {
              level: "info",
              data: JSON.stringify({
                type: "library_stream_complete",
                itemId,
                totalChunks,
                totalSize,
                timestamp: new Date().toISOString(),
                message: `Streaming complete: ${totalChunks} chunks, ${totalSize} bytes total`,
              }),
            },
          });
        }

        // Return final response with metadata and streaming info
        const finalResult = {
          item: libraryItemWithContent,
          content: shouldStream
            ? `[Content streamed in ${Math.ceil(
                totalSize / chunkSize,
              )} chunks via notifications - see notifications for actual content]`
            : content,
          source: "daemon_api",
          streaming: {
            enabled: shouldStream,
            totalSize,
            chunkSize,
            totalChunks: Math.ceil(totalSize / chunkSize),
            completed: shouldStream,
          },
          timestamp: new Date().toISOString(),
        };

        ctx.logger.info("MCP library_get_stream response", {
          itemId,
          hasContent: true,
          streamingEnabled: shouldStream,
          totalSize,
          totalChunks: Math.ceil(totalSize / chunkSize),
          streamingCompleted: shouldStream,
        });

        return createSuccessResponse(finalResult);
      } catch (error) {
        // Send error notification
        if (sendNotification) {
          const errMsg = error instanceof Error ? error.message : String(error);
          await sendNotification({
            method: "notifications/message",
            params: {
              level: "error",
              data: JSON.stringify({
                type: "library_stream_error",
                itemId,
                error: errMsg,
                timestamp: new Date().toISOString(),
                message: `Error retrieving library item: ${errMsg}`,
              }),
            },
          });
        }

        ctx.logger.error("MCP library_get_stream failed", {
          itemId,
          error: error instanceof Error ? error.message : String(error),
        });
        return createErrorResponse(
          `Failed to get library stream for item '${itemId}': ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  );
}
