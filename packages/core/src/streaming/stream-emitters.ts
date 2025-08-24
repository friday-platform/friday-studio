import type { StreamEmitter } from "@atlas/agent-sdk";
import type { Logger } from "@atlas/logger";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { StreamEvent } from "../types/streaming.ts";

/**
 * MCP Content Item type for testing stream conversion
 */
export type MCPContentItem =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/**
 * Stream emitter that buffers events for later retrieval.
 * Used for testing and scenarios where events need to be inspected.
 */
export interface CollectableStreamEmitter extends StreamEmitter {
  getCollectedEvents(): StreamEvent[];
}

/**
 * Stream emitter implementation that collects events in memory.
 * Used for testing and scenarios where events need to be inspected.
 */
export class CollectingStreamEmitter implements CollectableStreamEmitter {
  private events: StreamEvent[] = [];
  private ended = false;

  emit(event: StreamEvent): void {
    if (this.ended) {
      return; // Stop collecting after end() is called to prevent memory leaks
    }
    this.events.push(event);
  }

  end(): void {
    this.ended = true;
  }

  error(error: Error): void {
    this.emit({ type: "error", error });
  }

  getCollectedEvents(): StreamEvent[] {
    return [...this.events];
  }
}

/**
 * Streams events to Atlas daemon over HTTP.
 * Events are batched and sent to daemon's streaming endpoint,
 * which then broadcasts them to connected SSE clients (web UI, etc).
 */
export class HTTPStreamEmitter implements StreamEmitter {
  private buffer: StreamEvent[] = [];
  private flushInterval: ReturnType<typeof setInterval>;
  private ended = false;
  private logger: Logger;

  /**
   * @param streamId Unique identifier for this event stream
   * @param sessionId Session this stream belongs to
   * @param daemonUrl Atlas daemon HTTP endpoint
   * @param logger Logger instance for debugging
   */
  constructor(
    private streamId: string,
    private sessionId: string,
    private daemonUrl: string = "http://localhost:8080",
    logger: Logger,
  ) {
    this.logger = logger.child({ component: "HTTPStreamEmitter", streamId, sessionId });

    // Batch events every 50ms to reduce HTTP requests
    this.flushInterval = setInterval(() => this.flush(), 50);
  }

  /**
   * Buffers an event for transmission to daemon.
   * Triggers immediate flush if buffer gets too large.
   */
  emit(event: StreamEvent): void {
    if (this.ended) {
      this.logger.warn("Attempted to emit after stream ended", { event });
      return; // Graceful degradation - don't crash agent
    }

    this.buffer.push(event);

    // Prevent memory buildup under high event volume
    if (this.buffer.length > 100) {
      this.flush();
    }
  }

  /**
   * Sends buffered events to daemon's streaming endpoint.
   */
  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const events = this.buffer.splice(0, this.buffer.length);

    try {
      // Emit each buffered event to the unified stream emit endpoint
      for (const event of events) {
        // Normalize event type for UI where applicable
        const mappedType = event.type === "custom" ? event.eventType : event.type;

        const data = (() => {
          if (event.type === "custom") {
            return event.data as Record<string, unknown>;
          }
          switch (event.type) {
            case "thinking":
              return { content: event.content };
            case "error": {
              const err = event.error;
              return {
                content: typeof err === "string" ? err : String((err as Error).message ?? err),
              };
            }
            case "finish":
              return { content: event.reason };
            case "text":
              return { content: event.content };
            case "usage":
            case "progress":
            default:
              return { content: JSON.stringify(event) } as Record<string, unknown>;
          }
        })();

        const payload = {
          id: crypto.randomUUID(),
          type: mappedType,
          data,
          timestamp: new Date().toISOString(),
          sessionId: this.sessionId,
        };

        await fetch(`${this.daemonUrl}/api/stream/${this.streamId}/emit`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      }
    } catch (error) {
      this.logger.error("Failed to flush stream events", {
        error: error instanceof Error ? error.message : String(error),
        eventCount: events.length,
      });
    }
  }

  /**
   * Flushes remaining events and notifies daemon that stream is complete.
   */
  async end(): Promise<void> {
    await this.flush();
    clearInterval(this.flushInterval);
    this.ended = true;

    try {
      // Emit a finish event
      const payload = {
        id: crypto.randomUUID(),
        type: "finish",
        data: { content: "Stream ended" },
        timestamp: new Date().toISOString(),
        sessionId: this.sessionId,
      };
      await fetch(`${this.daemonUrl}/api/stream/${this.streamId}/emit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      this.logger.error("Failed to send stream end", { error });
    }
  }

  error(error: Error): void {
    this.emit({ type: "error", error });
    void this.end();
  }
}

/**
 * Null object pattern for disabled streaming.
 * Used when no stream ID is available or streaming is turned off.
 */
export class NoOpStreamEmitter implements StreamEmitter {
  emit(_event: StreamEvent): void {}
  end(): void {}
  error(_error: Error): void {}
}

/**
 * Delegates stream events to provided callback functions.
 * Used by agent wrappers that need custom event handling logic.
 */
export class CallbackStreamEmitter implements StreamEmitter {
  constructor(
    private onEmit: (event: StreamEvent) => void,
    private onEnd: () => void,
    private onError: (error: Error) => void,
  ) {}

  emit(event: StreamEvent): void {
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
  private buffer: StreamEvent[] = [];
  private flushInterval: ReturnType<typeof setInterval>;
  private ended = false;
  private hasEmittedContent = false;
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
    this.flushInterval = setInterval(() => this.flush(), 50);
  }

  emit(event: StreamEvent): void {
    if (this.ended) {
      throw new Error("Cannot emit after stream has ended");
    }

    this.buffer.push(event);
    this.hasEmittedContent = true;

    if (this.buffer.length > 100) {
      this.flush();
    }
  }

  /**
   * Sends buffered events via MCP notification.
   */
  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const events = this.buffer.splice(0, this.buffer.length);

    this.logger.debug("Flushing stream emitter events", { eventTypes: events.map((e) => e.type) });

    try {
      try {
        await this.server.notification({
          method: "notifications/tool/streamContent",
          params: { toolName: this.toolName, sessionId: this.sessionId, events },
        });
      } catch (notifyError) {
        this.logger.error("Failed to stream Agent Server notification", { error: notifyError });
        throw notifyError;
      }
    } catch (error) {
      this.logger.error("[MCPStreamEmitter] Failed to stream content:", { error });
    }
  }

  /**
   * Flushes remaining events and sends finish notification to MCP client.
   */
  async end(): Promise<void> {
    await this.flush();
    clearInterval(this.flushInterval);
    this.ended = true;

    if (this.hasEmittedContent) {
      await this.server.notification({
        method: "notifications/tool/streamContent",
        params: {
          toolName: this.toolName,
          sessionId: this.sessionId,
          events: [{ type: "finish", reason: "Stream ended" }],
        },
      });
    }
  }

  error(error: Error): void {
    this.emit({ type: "error", error });
    void this.end();
  }
}
