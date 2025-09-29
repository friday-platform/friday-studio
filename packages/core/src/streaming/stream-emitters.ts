import type { AtlasUIMessageChunk, StreamEmitter } from "@atlas/agent-sdk";
import type { Logger } from "@atlas/logger";
import { createAtlasClient } from "@atlas/oapi-client";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { NotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createErrorCause, throwWithCause } from "../errors.ts";

export const CancellationNotificationSchema = NotificationSchema.extend({
  method: z.literal("notifications/cancelled"),
  params: z.object({ requestId: z.string(), reason: z.string().optional() }),
});

export type CancellationNotification = z.infer<typeof CancellationNotificationSchema>;

export const StreamContentNotificationSchema = NotificationSchema.extend({
  method: z.literal("notifications/tool/streamContent"),
  params: z.object({
    toolName: z.string(),
    sessionId: z.string(),
    // type AtlasUIMessageChunk from @atlas/agent-sdk
    event: z.record(z.string(), z.unknown()),
  }),
});

/**
 * Streams events to Atlas daemon over HTTP.
 * Events are batched and sent to daemon's streaming endpoint,
 * which then broadcasts them to connected SSE clients (web UI, etc).
 */
export class HTTPStreamEmitter<T extends AtlasUIMessageChunk> implements StreamEmitter<T> {
  private client = createAtlasClient();
  private ended = false;
  private logger: Logger;

  /**
   * @param streamId Unique identifier for this event stream
   * @param sessionId Session this stream belongs to
   * @param logger Logger instance for debugging
   */
  constructor(
    private streamId: string,
    private sessionId: string,
    logger: Logger,
  ) {
    this.logger = logger.child({ component: "HTTPStreamEmitter", streamId, sessionId });
  }

  /**
   * Buffers an event for transmission to daemon.
   * Triggers immediate flush if buffer gets too large.
   */
  emit(event: AtlasUIMessageChunk): void {
    if (this.ended) {
      throw new Error("Cannot emit after stream has ended");
    }

    try {
      this.client.POST("/api/sse/{streamId}/emit", {
        params: { path: { streamId: this.streamId } },
        headers: { "X-Session-Id": this.sessionId },
        body: event,
      });
    } catch (error) {
      const errorCause = createErrorCause(error);
      this.logger.error("Failed stream event", {
        streamId: this.streamId,
        sessionId: this.sessionId,
        error: error,
        errorCause,
      });
      // Don't throw - streaming should continue even if one event fails
    }
  }

  end(): void {
    this.ended = true;
  }

  error(error: Error): void {
    this.logger.error("Stream error", { error });
    this.end();
  }
}

/**
 * Delegates stream events to provided callback functions.
 * Used by agent wrappers that need custom event handling logic.
 */
export class CallbackStreamEmitter implements StreamEmitter {
  constructor(
    private onEmit: (event: AtlasUIMessageChunk) => void,
    private onEnd: () => void,
    private onError: (error: Error) => void,
  ) {}

  emit(event: AtlasUIMessageChunk): void {
    this.onEmit(event);
  }

  end(): void {
    this.onEnd();
  }

  error(error: Error): void {
    this.onError(error);
  }
}

/**
 * Streams events via MCP protocol notifications.
 * Sends events to MCP clients using the notifications/tool/streamContent method.
 * @see https://modelcontextprotocol.io/docs/learn/architecture#notifications
 */
export class MCPStreamEmitter implements StreamEmitter {
  private ended = false;

  private logger: Logger;

  /**
   * @param server MCP server instance for sending notifications
   * @param toolName Name of the tool generating these events
   * @param sessionId Session identifier for event correlation
   * @param logger Logger instance
   */
  constructor(
    private server: Server,
    private toolName: string,
    private sessionId: string,
    logger: Logger,
  ) {
    this.logger = logger.child({ component: "MCPStreamEmitter", toolName, sessionId });
  }

  emit(event: AtlasUIMessageChunk): void {
    if (this.ended) {
      throw new Error("Cannot emit after stream has ended");
    }
    try {
      this.server.notification({
        method: "notifications/tool/streamContent",
        params: { toolName: this.toolName, sessionId: this.sessionId, event },
      });
    } catch (notifyError) {
      const errorCause = createErrorCause(notifyError);
      this.logger.error("Failed to stream Agent Server notification", {
        toolName: this.toolName,
        sessionId: this.sessionId,
        error: notifyError instanceof Error ? notifyError.message : String(notifyError),
        errorCause,
      });

      // Provide context-aware error messages
      if (errorCause.type === "network") {
        throwWithCause(
          "MCP connection lost. The agent server may be unavailable or disconnected.",
          notifyError instanceof Error ? notifyError : new Error(String(notifyError)),
        );
      }

      throwWithCause(
        `Failed to send stream notification to MCP client for tool '${this.toolName}'`,
        notifyError instanceof Error ? notifyError : new Error(String(notifyError)),
      );
    }
  }

  /**
   * Flushes remaining events and sends finish notification to MCP client.
   */
  end(): void {
    this.ended = true;
  }

  error(error: Error): void {
    this.logger.error("Stream error", { error });
    this.end();
  }
}
