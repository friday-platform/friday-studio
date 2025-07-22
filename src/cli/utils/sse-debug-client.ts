import { ConversationClient } from "./conversation-client.ts";
import { createEventSource } from "../../core/agents/remote/adapters/sse-utils.ts";
import { z } from "zod/v4";

export interface SSEDebugOptions {
  userId?: string;
  outputPath?: string;
  format?: "json" | "jsonl" | "pretty";
  filter?: string[];
  verbose?: boolean;
}

export interface SSEDebugEvent {
  // Event metadata
  timestamp: string;
  eventId: string;
  streamId: string;
  sequenceNumber: number;

  // Raw SSE data
  raw: {
    id?: string;
    event?: string;
    data: string;
  };

  // Parsed event
  parsed: {
    type: string;
    data: unknown;
    sessionId?: string;
    messageId?: string;
  };

  // Debug metadata
  debug: {
    receivedAt: string;
    processingTime: number;
    size: number;
    error?: string;
  };
}

// Re-create the SSE event schemas for validation
const SSEEventSchema = z.object({
  type: z.string(),
  data: z.unknown(),
  timestamp: z.string().optional(),
  sessionId: z.string().optional(),
  messageId: z.string().optional(),
});

export class SSEDebugClient extends ConversationClient {
  private eventLog: SSEDebugEvent[] = [];
  private sequenceCounter = 0;
  private logFile?: Deno.FsFile;
  private startTime = Date.now();
  protected daemonUrl: string;
  protected workspaceId: string;
  protected userId: string;

  constructor(
    daemonUrl: string,
    workspaceId: string,
    private options: SSEDebugOptions = {},
  ) {
    super(daemonUrl, workspaceId, options.userId || "sse-debug");
    this.daemonUrl = daemonUrl;
    this.workspaceId = workspaceId;
    this.userId = options.userId || "sse-debug";
  }

  async initializeLogging(): Promise<void> {
    if (this.options.outputPath) {
      // Create or open log file
      this.logFile = await Deno.open(this.options.outputPath, {
        create: true,
        write: true,
        append: this.options.format === "jsonl",
        truncate: this.options.format !== "jsonl",
      });

      // Write header for pretty JSON format
      if (this.options.format === "pretty") {
        await this.writeToFile(
          JSON.stringify(
            {
              session: {
                startTime: new Date(this.startTime).toISOString(),
                daemonUrl: this.daemonUrl,
                workspaceId: this.workspaceId,
                userId: this.userId,
              },
              events: [],
            },
            null,
            2,
          ).slice(0, -3) + "\n", // Remove closing braces to append events
        );
      }
    }
  }

  async *debugStreamEvents(
    sessionId: string,
    sseUrl?: string,
    abortSignal?: AbortSignal,
  ): AsyncIterableIterator<SSEDebugEvent> {
    const streamUrl = sseUrl ||
      `${this.daemonUrl}/system/conversation/sessions/${sessionId}/stream`;
    let eventSource: any = null;

    try {
      const startConnect = Date.now();
      eventSource = await createEventSource({
        url: streamUrl,
        options: abortSignal ? { signal: abortSignal } : undefined,
      });

      if (this.options.verbose) {
        console.log(`[SSE Debug] Connected to ${streamUrl} (${Date.now() - startConnect}ms)`);
      }

      for await (const message of eventSource.consume()) {
        const receivedAt = new Date().toISOString();
        const receiveTime = Date.now();

        if (abortSignal?.aborted) {
          break;
        }

        try {
          // Create debug event
          const debugEvent: SSEDebugEvent = {
            timestamp: new Date().toISOString(),
            eventId: crypto.randomUUID(),
            streamId: sessionId,
            sequenceNumber: this.sequenceCounter++,
            raw: {
              id: message.id,
              event: message.event,
              data: message.data,
            },
            parsed: {
              type: "unknown",
              data: null,
            },
            debug: {
              receivedAt,
              processingTime: 0,
              size: new TextEncoder().encode(message.data).length,
            },
          };

          // Try to parse the data
          try {
            const parsedData = JSON.parse(message.data);
            const validated = SSEEventSchema.safeParse(parsedData);

            if (validated.success) {
              debugEvent.parsed = {
                type: validated.data.type,
                data: validated.data.data || validated.data,
                sessionId: validated.data.sessionId,
                messageId: validated.data.messageId,
              };
            } else {
              debugEvent.parsed = {
                type: parsedData.type || "unknown",
                data: parsedData,
              };
              debugEvent.debug.error = "Schema validation failed";
            }
          } catch (parseError) {
            debugEvent.debug.error = `Parse error: ${parseError}`;
          }

          // Calculate processing time
          debugEvent.debug.processingTime = Date.now() - receiveTime;

          // Apply filters if specified
          if (this.shouldFilterEvent(debugEvent)) {
            continue;
          }

          // Log the event
          await this.logEvent(debugEvent);

          // Add to in-memory log
          this.eventLog.push(debugEvent);

          yield debugEvent;
        } catch (error) {
          console.error("[SSE Debug] Error processing message:", error);
        }
      }
    } catch (error) {
      throw new Error(
        `SSE connection failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (eventSource && eventSource.close) {
        eventSource.close();
      }
      await this.finalizeLogging();
    }
  }

  private shouldFilterEvent(event: SSEDebugEvent): boolean {
    if (!this.options.filter || this.options.filter.length === 0) {
      return false;
    }
    return !this.options.filter.includes(event.parsed.type);
  }

  private async logEvent(event: SSEDebugEvent): Promise<void> {
    // Console output if verbose
    if (this.options.verbose) {
      console.log(
        `[${event.sequenceNumber}] ${event.parsed.type} (${event.debug.size} bytes, ${event.debug.processingTime}ms)`,
      );
    }

    // File logging
    if (this.logFile) {
      switch (this.options.format) {
        case "jsonl":
          await this.writeToFile(JSON.stringify(event) + "\n");
          break;
        case "pretty":
          // Append to events array
          const eventJson = JSON.stringify(event, null, 2);
          const eventLines = eventJson.split("\n").map((line) => "    " + line).join("\n");
          await this.writeToFile("    " + eventLines + ",\n");
          break;
        default:
          // Regular JSON - store in memory and write at the end
          break;
      }
    }
  }

  private async writeToFile(content: string): Promise<void> {
    if (this.logFile) {
      await this.logFile.write(new TextEncoder().encode(content));
    }
  }

  private async finalizeLogging(): Promise<void> {
    if (!this.logFile) return;

    if (this.options.format === "pretty") {
      // Close the JSON structure
      await this.writeToFile(`  ],\n  "summary": ${
        JSON.stringify(
          this.generateSummary(),
          null,
          2,
        ).split("\n").map((line, i) => i > 0 ? "  " + line : line).join("\n")
      }\n}\n`);
    } else if (this.options.format === "json") {
      // Write complete JSON file
      const output = {
        session: {
          startTime: new Date(this.startTime).toISOString(),
          endTime: new Date().toISOString(),
          duration: Date.now() - this.startTime,
          daemonUrl: this.daemonUrl,
          workspaceId: this.workspaceId,
          userId: this.userId,
        },
        events: this.eventLog,
        summary: this.generateSummary(),
      };
      await this.writeToFile(JSON.stringify(output, null, 2));
    }

    this.logFile.close();
  }

  private generateSummary() {
    const eventTypes: Record<string, number> = {};
    let totalSize = 0;
    let totalProcessingTime = 0;
    let errors = 0;

    for (const event of this.eventLog) {
      eventTypes[event.parsed.type] = (eventTypes[event.parsed.type] || 0) + 1;
      totalSize += event.debug.size;
      totalProcessingTime += event.debug.processingTime;
      if (event.debug.error) errors++;
    }

    return {
      totalEvents: this.eventLog.length,
      duration: Date.now() - this.startTime,
      eventTypes,
      totalSize,
      averageProcessingTime: this.eventLog.length > 0
        ? totalProcessingTime / this.eventLog.length
        : 0,
      errors,
    };
  }

  // Convenience method to start monitoring
  async startMonitoring(options?: {
    createNewSession?: boolean;
    sessionId?: string;
    abortSignal?: AbortSignal;
  }): Promise<AsyncIterableIterator<SSEDebugEvent>> {
    await this.initializeLogging();

    let sessionId: string;
    let sseUrl: string | undefined;

    if (options?.createNewSession || !options?.sessionId) {
      if (this.options.verbose) {
        console.log(`[SSE Debug] Creating new session...`);
      }
      const session = await this.createSession({ createOnly: true });
      sessionId = session.sessionId;
      sseUrl = session.sseUrl;

      if (this.options.verbose) {
        console.log(`[SSE Debug] Created new session: ${sessionId}`);
        console.log(`[SSE Debug] SSE URL: ${sseUrl}`);
      }
    } else {
      sessionId = options.sessionId;
    }

    return this.debugStreamEvents(sessionId, sseUrl, options?.abortSignal);
  }

  // Get event statistics
  getStatistics() {
    return this.generateSummary();
  }

  // Get filtered events
  getEvents(filter?: { type?: string; startTime?: Date; endTime?: Date }): SSEDebugEvent[] {
    let events = [...this.eventLog];

    if (filter?.type) {
      events = events.filter((e) => e.parsed.type === filter.type);
    }

    if (filter?.startTime) {
      events = events.filter((e) => new Date(e.timestamp) >= filter.startTime!);
    }

    if (filter?.endTime) {
      events = events.filter((e) => new Date(e.timestamp) <= filter.endTime!);
    }

    return events;
  }
}
