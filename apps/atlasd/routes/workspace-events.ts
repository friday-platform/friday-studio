/**
 * GET /api/workspaces/:workspaceId/events
 *
 * Returns recent operational events for a workspace, sorted newest
 * first. Drives the playground `/schedules` page and any future
 * workspace-side audit UI.
 *
 * Today only `schedule.missed` events are emitted (by CronManager
 * onMissed coalesce/catchup paths). The shape is open for future
 * event types — the union grows as new emitters are wired into
 * `WorkspaceEvent`.
 */

import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { daemonFactory } from "../src/factory.ts";
import { listAllWorkspaceEvents, listWorkspaceEvents } from "../src/workspace-events.ts";

const ParamSchema = z.object({ workspaceId: z.string() });
const QuerySchema = z.object({ limit: z.coerce.number().int().positive().max(500).optional() });

export const workspaceEventsRoutes = daemonFactory
  .createApp()
  .get(
    "/:workspaceId/events",
    zValidator("param", ParamSchema),
    zValidator("query", QuerySchema),
    async (c) => {
      const { workspaceId } = c.req.valid("param");
      const { limit } = c.req.valid("query");
      const ctx = c.get("app");
      const nc = ctx.daemon.getNatsConnection();
      if (!nc) return c.json({ error: "NATS connection not ready" }, 503);
      const events = await listWorkspaceEvents(nc, workspaceId, {
        ...(limit !== undefined ? { limit } : {}),
      });
      return c.json({ events }, 200);
    },
  );

/**
 * Global feed — every workspace's recent events in one list. Drives
 * the top-level `/schedules` page; per-workspace pages use the
 * `/api/workspaces/:workspaceId/events` variant above.
 */
export const eventsRoutes = daemonFactory
  .createApp()
  .get("/", zValidator("query", QuerySchema), async (c) => {
    const { limit } = c.req.valid("query");
    const ctx = c.get("app");
    const nc = ctx.daemon.getNatsConnection();
    if (!nc) return c.json({ error: "NATS connection not ready" }, 503);
    const events = await listAllWorkspaceEvents(nc, { ...(limit !== undefined ? { limit } : {}) });
    return c.json({ events }, 200);
  });

export type WorkspaceEventsRoutes = typeof workspaceEventsRoutes;
export type EventsRoutes = typeof eventsRoutes;
