import { logger } from "@atlas/logger";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod/v4";
import { daemonFactory } from "../../src/factory.ts";
import { errorResponseSchema } from "../../src/utils.ts";

const sseStreamRoute = daemonFactory.createApp();

/**
 * GET /:streamId/stream - SSE endpoint for real-time agent responses.
 *
 * Establishes Server-Sent Events connection using Vercel AI SDK protocol.
 * Agents stream UIMessageChunks through this channel for real-time UI updates.
 */
sseStreamRoute.get(
  "/",
  describeRoute({
    tags: ["Streams"],
    summary: "Subscribe to stream events (AI SDK Protocol)",
    description: "Opens SSE stream using Vercel AI SDK protocol for real-time agent responses",
    responses: {
      200: {
        description: "SSE stream opened (AI SDK protocol)",
        content: {
          "text/event-stream": {
            schema: resolver(
              z.object({
                type: z.string(),
                format: z.literal("event-stream"),
                description: z.literal("AI SDK UI Message Stream"),
              }),
            ),
          },
        },
      },
      404: {
        description: "Stream not found",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
      },
    },
  }),
  validator("param", z.object({ streamId: z.string() })),
  (c) => {
    const ctx = c.get("app");
    const { streamId } = c.req.valid("param");

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start: (controller) => {
        const now = Date.now();

        if (!ctx.sseStreams.has(streamId)) {
          ctx.sseStreams.set(streamId, { createdAt: now, lastActivity: now, lastEmit: now });
        } else {
          // Update activity on reconnect
          const streamMeta = ctx.sseStreams.get(streamId);
          streamMeta.lastActivity = now;
        }

        if (!ctx.sseClients.has(streamId)) {
          ctx.sseClients.set(streamId, []);
        }

        const clientInfo = {
          controller,
          connectedAt: now,
          lastActivity: now,
          textStreamState: new Map<string, { started: boolean; ended: boolean }>(),
        };

        ctx.sseClients.get(streamId).push(clientInfo);

        logger.info("SSE client connected", {
          streamId,
          clientCount: ctx.sseClients.get(streamId).length,
        });

        const connectionEvent = {
          type: "data-connection",
          data: { sessionId: streamId, timestamp: new Date().toISOString() },
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(connectionEvent)}\n\n`));

        const heartbeatInterval = setInterval(() => {
          try {
            const heartbeat = { type: "data-heartbeat", timestamp: Date.now() };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(heartbeat)}\n\n`));
            clientInfo.lastActivity = Date.now();
          } catch (error) {
            clearInterval(heartbeatInterval);
            logger.info("Heartbeat failed, client disconnected", { streamId, error });
          }
        }, 30000);

        c.req.raw.signal.addEventListener("abort", () => {
          clearInterval(heartbeatInterval);
          const clients = ctx.sseClients.get(streamId);
          if (clients) {
            const index = clients.indexOf(clientInfo);
            if (index > -1) {
              clients.splice(index, 1);
            }

            if (clients.length === 0) {
              ctx.sseClients.delete(streamId);
              // DON'T delete from sseStreams - let the watchdog handle it
            }
          }

          logger.info("SSE client disconnected", {
            streamId,
            remainingClients: ctx.sseClients.get(streamId)?.length || 0,
          });
        });
      },
    });

    return new Response(stream, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  },
);

export { sseStreamRoute };
