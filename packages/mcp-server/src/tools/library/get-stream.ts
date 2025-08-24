import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../types.ts";
import { createSendNotification, createSuccessResponse } from "../types.ts";
import { fetchWithTimeout, handleDaemonResponse } from "../utils.ts";

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
        const metadataUrl = `${ctx.daemonUrl}/api/library/${itemId}`;
        const metadataResponse = await fetchWithTimeout(metadataUrl);
        const metadata = await handleDaemonResponse(
          metadataResponse,
          "library_get_metadata",
          ctx.logger,
        );

        if (!metadata || !metadata.item) {
          throw new Error(`Library item not found: ${itemId}`);
        }

        // Send metadata notification
        if (sendNotification) {
          await sendNotification({
            method: "notifications/message",
            params: {
              level: "info",
              data: JSON.stringify({
                type: "library_metadata",
                itemId,
                metadata: metadata.item,
                timestamp: new Date().toISOString(),
                message: `Found library item: ${metadata.item.name}`,
              }),
            },
          });
        }

        if (!includeContent) {
          // Return metadata only
          return createSuccessResponse({
            item: metadata.item,
            source: "daemon_api",
            streaming: false,
            timestamp: new Date().toISOString(),
          });
        }

        // Get content
        const contentUrl = `${ctx.daemonUrl}/api/library/${itemId}?content=true`;
        const contentResponse = await fetchWithTimeout(contentUrl);
        const result = await handleDaemonResponse(
          contentResponse,
          "library_get_content",
          ctx.logger,
        );

        if (!result || !("content" in result)) {
          throw new Error(`Failed to retrieve content for library item: ${itemId}`);
        }

        const content = result.content as string;
        const totalSize = content.length;

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
            const chunk = content.slice(start, end);
            const chunkNumber = i + 1;

            // Send chunk via notification silently (no log line per chunk)
            await sendNotification(
              {
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
              },
              true,
            ); // silent = true

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
          item: result.item,
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
          hasContent: "content" in result,
          streamingEnabled: shouldStream,
          totalSize,
          totalChunks: Math.ceil(totalSize / chunkSize),
          streamingCompleted: shouldStream,
        });

        return createSuccessResponse(finalResult);
      } catch (error) {
        // Send error notification
        if (sendNotification) {
          await sendNotification({
            method: "notifications/message",
            params: {
              level: "error",
              data: JSON.stringify({
                type: "library_stream_error",
                itemId,
                error: (error as Error).message,
                timestamp: new Date().toISOString(),
                message: `Error retrieving library item: ${(error as Error).message}`,
              }),
            },
          });
        }

        ctx.logger.error("MCP library_get_stream failed", { itemId, error });
        throw error;
      }
    },
  );
}
