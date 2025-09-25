import { logger } from "@atlas/logger";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod/v4";
import { type AppContext, daemonFactory } from "../../src/factory.ts";
import { errorResponseSchema } from "../../src/utils.ts";

const emitEventRoute = daemonFactory.createApp();

// Queue structure types
interface QueuedEmission {
  event: unknown;
  resolve: (value: EmissionResult) => void;
  reject: (error: Error) => void;
  timestamp: number;
  metadata?: { sessionId?: string; workspaceId?: string; agentId?: string };
}

interface EmissionResult {
  success: boolean;
  message: string;
  clientCount?: number;
  queueDepth?: number;
}

// Session-based queueing: streamId -> sessionId -> queues
const streamQueues = new Map<string, Map<string, QueuedEmission[]>>();
const activeSession = new Map<string, string | null>(); // streamId -> active sessionId
const streamProcessing = new Map<string, boolean>();
const sessionTimeouts = new Map<string, ReturnType<typeof setTimeout>>(); // Dead session protection

/**
 * Queue an event for emission with session-based ordering
 */
function emitToStream(
  ctx: AppContext,
  streamId: string,
  event: unknown,
  metadata?: QueuedEmission["metadata"],
): Promise<EmissionResult> {
  return new Promise((resolve, reject) => {
    const sessionId = metadata?.sessionId || "unknown";

    // Initialize stream queue structure if needed
    if (!streamQueues.has(streamId)) {
      streamQueues.set(streamId, new Map());
    }

    const streamSessionQueues = streamQueues.get(streamId);

    // Get or create session queue
    if (!streamSessionQueues.has(sessionId)) {
      streamSessionQueues.set(sessionId, []);
    }

    const sessionQueue = streamSessionQueues.get(sessionId);
    const queueItem = { event, resolve, reject, timestamp: Date.now(), metadata };
    sessionQueue.push(queueItem);

    // If no active session, make this one active
    if (!activeSession.get(streamId) && !streamProcessing.get(streamId)) {
      activeSession.set(streamId, sessionId);
      logger.debug("Session claimed stream", { streamId, sessionId });
      processStreamQueue(ctx, streamId);
    }
    // If this is the active session and processor isn't running, start it
    else if (activeSession.get(streamId) === sessionId && !streamProcessing.get(streamId)) {
      processStreamQueue(ctx, streamId);
    }
    // Otherwise, it's queued for later
    else if (activeSession.get(streamId) !== sessionId) {
      logger.debug("Session queued for later", {
        streamId,
        sessionId,
        activeSession: activeSession.get(streamId),
      });
    }
  });
}

/**
 * Process queued emissions with session-based ordering
 */
async function processStreamQueue(ctx: AppContext, streamId: string): Promise<void> {
  if (streamProcessing.get(streamId)) {
    logger.debug("Queue processor already running", { streamId });
    return;
  }
  streamProcessing.set(streamId, true);

  try {
    while (activeSession.get(streamId)) {
      const currentSessionId = activeSession.get(streamId);
      const streamSessionQueues = streamQueues.get(streamId);

      if (!streamSessionQueues) {
        logger.debug("No session queues found", { streamId });
        break;
      }

      const sessionQueue = streamSessionQueues.get(currentSessionId);
      if (!sessionQueue || sessionQueue.length === 0) {
        // DO NOT rotate on empty queue - wait for explicit session-finish event
        // Sessions must explicitly signal completion via data-session-finish
        // This prevents premature rotation and message interleaving
        break; // Exit processing loop but keep session active
      }

      const item = sessionQueue.shift();

      // Clear any existing timeout for this session
      const timeoutKey = `${streamId}:${currentSessionId}`;
      if (sessionTimeouts.has(timeoutKey)) {
        clearTimeout(sessionTimeouts.get(timeoutKey));
        sessionTimeouts.delete(timeoutKey);
      }

      // Check if this is a session-finish event
      const isSessionFinish = isSessionFinishEvent(item.event);

      // Timeout check (5 seconds for being in queue)
      if (Date.now() - item.timestamp > 5000) {
        item.reject(new Error("Emission timeout - message queued too long"));
        logger.warn("SSE emission timeout", {
          streamId,
          sessionId: currentSessionId,
          age: Date.now() - item.timestamp,
          metadata: item.metadata,
        });
        continue;
      }

      // Process the emission
      try {
        const result = await emitToClients(ctx, streamId, item.event);
        item.resolve(result);
      } catch (error) {
        item.reject(error);
        logger.error("SSE emission failed", {
          streamId,
          sessionId: currentSessionId,
          error,
          metadata: item.metadata,
        });
      }

      // If session finished, rotate immediately
      if (isSessionFinish) {
        logger.info("Session finished, rotating to next", {
          streamId,
          sessionId: currentSessionId,
        });
        streamSessionQueues.delete(currentSessionId); // Clean up queue
        rotateSession(streamId);
      } else {
        // Set timeout for dead session (30s)
        const timeoutKey = `${streamId}:${currentSessionId}`;
        sessionTimeouts.set(
          timeoutKey,
          setTimeout(() => {
            logger.warn("Session timeout, forcing rotation", {
              streamId,
              sessionId: currentSessionId,
            });
            if (activeSession.get(streamId) === currentSessionId) {
              rotateSession(streamId);
              // Restart processing if needed
              if (!streamProcessing.get(streamId) && activeSession.get(streamId)) {
                processStreamQueue(ctx, streamId);
              }
            }
          }, 30000),
        );
      }
    }
  } finally {
    streamProcessing.set(streamId, false);
  }
}

/**
 * Check if an event indicates session completion
 * IMPORTANT: Only detect actual session-finish events, not agent-level events
 */
function isSessionFinishEvent(event: unknown): boolean {
  if (typeof event === "object" && event !== null) {
    const evt = event;
    // Only check for explicit session-finish event
    // Do NOT rotate on agent-finish or generic finish events
    return evt.type === "data-session-finish";
  }
  return false;
}

/**
 * Rotate to the next session with queued items
 */
function rotateSession(streamId: string): void {
  const streamSessionQueues = streamQueues.get(streamId);
  const currentSession = activeSession.get(streamId);

  if (!streamSessionQueues) {
    activeSession.delete(streamId);
    logger.debug("No more sessions, stream idle", { streamId });
    return;
  }

  // Clean up current session timeout if exists
  if (currentSession) {
    const timeoutKey = `${streamId}:${currentSession}`;
    if (sessionTimeouts.has(timeoutKey)) {
      clearTimeout(sessionTimeouts.get(timeoutKey));
      sessionTimeouts.delete(timeoutKey);
    }
  }

  // Find next session with queued items
  for (const [sessionId, queue] of streamSessionQueues) {
    if (queue.length > 0 && sessionId !== currentSession) {
      activeSession.set(streamId, sessionId);
      logger.info("Rotated to next session", {
        streamId,
        previousSessionId: currentSession,
        newSessionId: sessionId,
        queueLength: queue.length,
      });
      return;
    }
  }

  // No more sessions with items
  activeSession.delete(streamId);
  logger.debug("No more sessions with queued items, stream idle", { streamId });
}

/**
 * Atomically emit to all SSE clients for a stream
 */
function emitToClients(ctx: AppContext, streamId: string, event: unknown): Promise<EmissionResult> {
  const clients = ctx.sseClients.get(streamId);

  // Update stream activity
  const now = Date.now();
  const streamMeta = ctx.sseStreams.get(streamId);
  if (streamMeta) {
    streamMeta.lastActivity = now;
    streamMeta.lastEmit = now;
  }

  if (!clients || clients.length === 0) {
    logger.debug("No connected clients for stream", { streamId });
    return Promise.resolve({
      success: true,
      message: "Stream updated, no active clients",
      clientCount: 0,
    });
  }

  // Prepare SSE data once
  const sseData = `data: ${JSON.stringify(event)}\n\n`;
  const encoder = new TextEncoder();
  const encodedData = encoder.encode(sseData);

  const disconnectedClients: typeof clients = [];

  // Emit to all clients atomically
  for (const client of clients) {
    try {
      client.controller.enqueue(encodedData);
      client.lastActivity = now;
    } catch (error) {
      logger.debug("SSE client disconnected during emission", {
        streamId,
        error: error instanceof Error ? error.message : String(error),
      });
      disconnectedClients.push(client);
    }
  }

  // Clean up disconnected clients
  if (disconnectedClients.length > 0) {
    const remainingClients = clients.filter((c) => !disconnectedClients.includes(c));

    if (remainingClients.length === 0) {
      ctx.sseClients.delete(streamId);
    } else {
      ctx.sseClients.set(streamId, remainingClients);
    }
  }

  const successCount = clients.length - disconnectedClients.length;
  return Promise.resolve({
    success: true,
    message: `Event emitted to ${successCount} clients`,
    clientCount: successCount,
  });
}

/**
 * POST /:streamId/emit - Forward UIMessageChunk events to SSE clients.
 *
 * Internal endpoint used by HTTPStreamEmitter to push AI SDK formatted
 * events to connected clients. Events pass through without transformation.
 */
emitEventRoute.post(
  "/",
  describeRoute({
    tags: ["Streams"],
    summary: "Emit UIMessageChunk event to stream",
    description: "Forward AI SDK events from agents to SSE clients",
    responses: {
      200: {
        description: "Event emitted successfully",
        content: {
          "application/json": {
            schema: resolver(
              z.object({
                success: z.boolean(),
                message: z.string().optional(),
                clientCount: z.number().optional(),
                queueDepth: z.number().optional(),
              }),
            ),
          },
        },
      },
      400: {
        description: "Invalid request parameters",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
      },
      404: {
        description: "Stream not found or no connected clients",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
      },
    },
  }),
  validator("param", z.object({ streamId: z.string() })),
  validator("json", z.unknown()),
  async (c) => {
    const ctx = c.get("app");
    const { streamId } = c.req.valid("param");
    const event = c.req.valid("json");

    // Extract metadata from headers if available
    const metadata = {
      sessionId: c.req.header("X-Session-Id"),
      workspaceId: c.req.header("X-Workspace-Id"),
      agentId: c.req.header("X-Agent-Id"),
    };

    // Create stream metadata if it doesn't exist (e.g., inherited from another session)
    const now = Date.now();
    if (!ctx.sseStreams.has(streamId)) {
      ctx.sseStreams.set(streamId, { createdAt: now, lastActivity: now, lastEmit: now });
    }

    try {
      // Queue and process with session-based ordering
      const result = await emitToStream(ctx, streamId, event, metadata);

      // Add queue depth to response for monitoring
      const streamSessionQueues = streamQueues.get(streamId);
      if (streamSessionQueues) {
        let totalQueued = 0;
        for (const queue of streamSessionQueues.values()) {
          totalQueued += queue.length;
        }
        result.queueDepth = totalQueued;
      }

      return c.json(result);
    } catch (error) {
      logger.error("Failed to queue emission", { streamId, error });
      return c.json({ error: "Failed to queue emission", details: String(error) }, 500);
    }
  },
);

export { emitEventRoute };
