import type { AtlasUIMessageChunk, StreamEmitter } from "@atlas/agent-sdk";
import type { Logger } from "@atlas/logger";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { NotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createErrorCause } from "../errors.ts";

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
    // Runtime validation: event must have a type property (AtlasUIMessageChunk)
    event: z.looseObject({
      type: z.string(),
      id: z.string().optional(),
      data: z.unknown().optional(),
      transient: z.boolean().optional(),
    }),
  }),
});

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
      // Don't throw - streaming should continue even if one notification fails
      // This prevents agent crashes when MCP notifications fail to send
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
