import type { AtlasUIMessageChunk } from "@atlas/agent-sdk";
import { logger } from "@atlas/logger";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";
import { type AppContext, daemonFactory } from "../../src/factory.ts";
import { errorResponseSchema } from "../../src/utils.ts";

const emitEventRoute = daemonFactory.createApp();

// Queue structure types
interface QueuedEmission {
  event: AtlasUIMessageChunk;
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
const activeSession = new Map<string, string>(); // streamId -> active sessionId
const streamProcessing = new Set<string>(); // Set of streams currently processing
const sessionTimeouts = new Map<string, ReturnType<typeof setTimeout>>(); // Dead session protection

/**
 * Queue an event for emission with session-based ordering
 */
function emitToStream(
  ctx: AppContext,
  streamId: string,
  event: AtlasUIMessageChunk,
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
    if (!streamSessionQueues?.has(sessionId)) {
      streamSessionQueues?.set(sessionId, []);
    }

    const sessionQueue = streamSessionQueues?.get(sessionId);
    const queueItem = { event, resolve, reject, timestamp: Date.now(), metadata };
    sessionQueue?.push(queueItem);

    // Cache Map lookups to avoid redundant operations
    const currentActiveId = activeSession.get(streamId);
    const isActiveSession = currentActiveId === sessionId;
    const isProcessing = streamProcessing.has(streamId);

    // If no active session, make this one active
    if (!currentActiveId && !isProcessing) {
      activeSession.set(streamId, sessionId);
      logger.debug("Session claimed stream", { streamId, sessionId });
      processStreamQueue(ctx, streamId);
    }
    // If this is the active session and processor isn't running, start it
    else if (isActiveSession && !isProcessing) {
      processStreamQueue(ctx, streamId);
    }
    // If this is the active session but processor is currently stopping (stall window), schedule a restart tick
    else if (isActiveSession && isProcessing) {
      // Only schedule if the queue transitioned from empty -> 1 (likely stall case)
      if ((sessionQueue?.length ?? 0) === 1) {
        setTimeout(() => {
          // Re-check conditions since this executes later
          if (!streamProcessing.has(streamId) && activeSession.get(streamId) === sessionId) {
            logger.debug("Restarting stalled stream processor after enqueue", {
              streamId,
              sessionId,
            });
            processStreamQueue(ctx, streamId);
          }
        }, 0);
      }
    }
    // Otherwise, it's queued for later
    else {
      logger.debug("Session queued for later", {
        streamId,
        sessionId,
        activeSession: currentActiveId,
      });

      // If the active session is idle (no pending items) and the processor is not running,
      // rotate immediately to whichever session has work (soft-rotate on enqueue).
      const activeQueueEmpty = currentActiveId
        ? (streamSessionQueues?.get(currentActiveId)?.length ?? 0) === 0
        : true;

      if (activeQueueEmpty && !isProcessing) {
        rotateSession(streamId);
        if (activeSession.get(streamId)) {
          processStreamQueue(ctx, streamId);
        }
      }
    }
  });
}

/**
 * Process queued emissions with session-based ordering
 */
async function processStreamQueue(ctx: AppContext, streamId: string): Promise<void> {
  if (streamProcessing.has(streamId)) {
    logger.debug("Queue processor already running", { streamId });
    return;
  }
  streamProcessing.add(streamId);

  try {
    while (activeSession.get(streamId)) {
      const currentSessionId = activeSession.get(streamId);
      const streamSessionQueues = streamQueues.get(streamId);

      if (!streamSessionQueues) {
        logger.debug("No session queues found", { streamId });
        break;
      }

      if (!currentSessionId) {
        logger.debug("No active session found", { streamId });
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

      if (!item) {
        logger.debug("No item found in session queue", { streamId, sessionId: currentSessionId });
        break;
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
        item.reject(new Error("SSE Emission failed", { cause: error }));
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
        // Force-delete queue and reject pending items (same as timeout handling)
        rotateSession(streamId, true);
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
              // Force-delete the timed-out session's queue to prevent it from reclaiming the stream
              // This is the fix for the production bug where session c327d791 timed out 3 times
              rotateSession(streamId, true);

              // Restart processing if needed
              if (!streamProcessing.has(streamId) && activeSession.get(streamId)) {
                processStreamQueue(ctx, streamId);
              }
            }
          }, 30000),
        );
      }
    }
  } finally {
    streamProcessing.delete(streamId);
  }
}

/**
 * Check if an event indicates session completion
 * IMPORTANT: Only detect actual session-finish events, not agent-level events
 */
function isSessionFinishEvent(event: AtlasUIMessageChunk): boolean {
  // Only check for explicit session-finish event
  return event.type === "data-session-finish";
}

/**
 * Rotate to the next session with queued items
 */
function rotateSession(streamId: string, forceDeleteCurrent = false): void {
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

  // Force-delete current session's queue if requested (session ended)
  if (forceDeleteCurrent && currentSession) {
    const queue = streamSessionQueues.get(currentSession);
    if (queue) {
      // Reject any pending items before deleting the queue
      queue.forEach((item) => {
        item.reject(new Error("Session ended"));
      });
      streamSessionQueues.delete(currentSession);
      logger.debug("Force-deleted queue for ended session", {
        streamId,
        sessionId: currentSession,
        rejectedItems: queue.length,
      });
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

  // Remove empty current session queue (normal rotation cleanup)
  if (!forceDeleteCurrent && currentSession) {
    const queue = streamSessionQueues.get(currentSession);
    if (queue && queue.length === 0) {
      logger.debug("Removing empty session queue", { streamId, sessionId: currentSession });
      streamSessionQueues.delete(currentSession);
    }
  }

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
      logger.debug("SSE client disconnected during emission", { streamId, error });
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
 *
 * SSE stream emission endpoint
 *
 * Handles SSE streaming for signal-triggered sessions.
 *
 * Note: Job sessions triggered via MCP tools use MCP notifications
 * instead of SSE streams, avoiding the stream contention issue.
 * Both execution paths coexist:
 * - Signal path: External triggers → signals → SSE streams
 * - MCP path: Conversation agent → MCP tools → MCP notifications
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
    /**
     * Explicit type assertion  - we're currently not validating UI Message chunks.
     * @todo https://ai-sdk.dev/docs/reference/ai-sdk-core/validate-ui-messages#validateuimessages
     */
    const event = c.req.valid("json") as AtlasUIMessageChunk;

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
