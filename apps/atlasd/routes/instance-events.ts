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
    // Core NATS subscription, not a JetStream consumer — the daemon
    // re-subscribes automatically on reconnect, but messages published
    // while the daemon's NATS connection was disconnected are LOST.
    // Acceptable here because the playground is a dev tool and the
    // replay endpoint (`?since=<seq>`) covers reload-after-disconnect.
    // For a production-grade ops UI an ordered ephemeral push consumer
    // (DeliverPolicy=New) would survive disconnects with replay, at
    // the cost of one consumer per HTTP client.
    const subject = type ? `instance.${type}` : "instance.>";
    const sub = nc.subscribe(subject);
    // The `subscribe()` call returns before the broker actually registers
    // the subscription. Without this flush, an event published in the
    // window between subscribe-returns and broker-registers would be
    // silently dropped. The flush forces a PING/PONG round-trip; once
    // it resolves, the subscription is live server-side and the SSE
    // handshake honestly means "from now on, you get every event."
    await nc.flush();

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
            // for-await exited early — most often because the SSE
            // controller threw in `enqueue` after the consumer cancelled
            // (e.g. browser closed the EventSource). The abort listener
            // normally tears down the NATS subscription on its own, but
            // controller-cancel can land first; defense-in-depth in the
            // finally below ensures we never leak the subscription.
          } finally {
            try {
              sub.unsubscribe();
            } catch {
              // already gone — abort listener fired first
            }
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
