/**
 * GET /api/instance/events
 *
 * Paginated replay over the INSTANCE_EVENTS stream, newest first.
 * Used by late joiners and reload-after-disconnect; live updates flow
 * through the per-user firehose at `/api/me/stream`.
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
  limit: z.coerce.number().int().positive().max(500).optional(),
  /**
   * Subject suffix filter — e.g. `cascade.` for all cascade events,
   * or `cascade.queue_saturated` for one type. Matched as a prefix
   * after `instance.`.
   */
  type: z.string().optional(),
});

export const instanceEventsRoutes = daemonFactory
  .createApp()
  .get("/events", zValidator("query", QuerySchema), async (c) => {
    const { limit, type } = c.req.valid("query");
    const ctx = c.get("app");
    const nc = ctx.daemon.getNatsConnection();
    if (!nc) return c.json({ error: "NATS connection not ready" }, 503);

    const events = await listInstanceEvents(nc, {
      ...(limit !== undefined ? { limit } : {}),
      ...(type !== undefined ? { typeFilter: type } : {}),
    });
    return c.json({ events }, 200);
  });
