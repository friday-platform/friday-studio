/**
 * GET /api/instance/events
 *
 * Two modes:
 *   - `?stream=true`        — SSE feed; subscribes to the `instance.>`
 *                             NATS subject and forwards each event as a
 *                             `data:` frame. UI consumers don't poll.
 *   - default (or `?since`) — paginated replay over the INSTANCE_EVENTS
 *                             stream, newest first. Useful for late
 *                             joiners and reload-after-disconnect.
 *
 * Today the stream carries cascade-related events
 * (`cascade.queue_saturated`, `cascade.queue_drained`,
 * `cascade.queue_timeout`, `cascade.replaced`). The shape is open for
 * future `daemon.*` / `health.*` event types without a stream split.
 */

import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { daemonFactory } from "../src/factory.ts";
import { listInstanceEvents } from "../src/instance-events.ts";

const QuerySchema = z.object({
  stream: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
  /**
   * Subject suffix filter — e.g. `cascade.` for all cascade events,
   * or `cascade.queue_saturated` for one type. Matched as a prefix
   * after `instance.`.
   */
  type: z.string().optional(),
});

const enc = new TextEncoder();

export const instanceEventsRoutes = daemonFactory
  .createApp()
  .get("/events", zValidator("query", QuerySchema), async (c) => {
    const { stream, limit, type } = c.req.valid("query");
    const ctx = c.get("app");
    const nc = ctx.daemon.getNatsConnection();
    if (!nc) return c.json({ error: "NATS connection not ready" }, 503);

    if (!stream) {
      // Replay path — backwards walk over the stream.
      const events = await listInstanceEvents(nc, {
        ...(limit !== undefined ? { limit } : {}),
        ...(type !== undefined ? { typeFilter: type } : {}),
      });
      return c.json({ events }, 200);
    }

    // SSE path — live feed.
    const subject = type ? `instance.${type}` : "instance.>";
    const sub = nc.subscribe(subject);

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        c.req.raw.signal.addEventListener("abort", () => {
          try {
            sub.unsubscribe();
          } catch {
            // already gone
          }
          try {
            controller.close();
          } catch {
            // already closed
          }
        });

        void (async () => {
          try {
            for await (const msg of sub) {
              // Forward the raw event JSON as a `data:` frame. The
              // event subject is recoverable from `event.type`, so we
              // don't need an explicit `event:` line.
              const payload = msg.string();
              controller.enqueue(enc.encode(`data: ${payload}\n\n`));
            }
          } catch {
            // subscription closed — fall through to controller.close()
          } finally {
            try {
              controller.close();
            } catch {
              // already closed
            }
          }
        })();
      },
    });

    return c.body(body, 200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
  });
