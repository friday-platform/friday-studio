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
import {
  listAllWorkspaceEvents,
  listWorkspaceEvents,
  markAllPendingForSignal,
  markEventDismissed,
  markEventFired,
} from "../src/workspace-events.ts";

const ParamSchema = z.object({ workspaceId: z.string() });
const QuerySchema = z.object({ limit: z.coerce.number().int().positive().max(500).optional() });

/**
 * Body for `POST /api/events/fire` and `/dismiss`. The composite
 * (workspaceId, signalId, scheduledAt) uniquely identifies a manual
 * `schedule.missed` event — same shape used to derive the KV state
 * key in workspace-events.ts.
 */
const ManualActionBodySchema = z.object({
  workspaceId: z.string(),
  signalId: z.string(),
  scheduledAt: z.string(),
});

/**
 * Body for `POST /api/events/group`. Operates on every pending
 * manual event for a (workspaceId, signalId) pair — the operator
 * acts on N missed slots in one click.
 *
 * - "fire-once"   — fires the signal once now; ALL pending events
 *                   in the group are marked fired (the single
 *                   firing is treated as covering them all).
 * - "fire-all"    — fires the signal once per pending event; each
 *                   event is marked fired with its own slot.
 * - "dismiss-all" — drops every pending event in the group. No
 *                   firings.
 */
const GroupActionBodySchema = z.object({
  workspaceId: z.string(),
  signalId: z.string(),
  action: z.enum(["fire-once", "fire-all", "dismiss-all"]),
});

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
  })
  /**
   * Fire a pending manual `schedule.missed` event. Triggers the
   * underlying signal via the same JetStream publish path the cron
   * tick loop uses, then flips the KV state to `fired`. 404 if the
   * event isn't pending (already fired, dismissed, or doesn't exist).
   */
  .post("/fire", zValidator("json", ManualActionBodySchema), async (c) => {
    const { workspaceId, signalId, scheduledAt } = c.req.valid("json");
    const ctx = c.get("app");
    const nc = ctx.daemon.getNatsConnection();
    if (!nc) return c.json({ error: "NATS connection not ready" }, 503);

    // Trigger the signal first (the publish ack tells us the broker
    // accepted the message); flip KV state only after a successful
    // publish so a failed fire stays "pending" and is retryable.
    try {
      await ctx.daemon.publishSignalToJetStream({
        workspaceId,
        signalId,
        payload: {
          source: "manual-make-up",
          scheduled: scheduledAt,
          actualFiredAt: new Date().toISOString(),
        },
      });
    } catch (err) {
      return c.json({ error: `Failed to trigger signal: ${String(err)}` }, 500);
    }

    const ok = await markEventFired(nc, workspaceId, signalId, scheduledAt);
    if (!ok) return c.json({ error: "Event not found or already fired/dismissed" }, 404);
    return c.json({ ok: true }, 200);
  })
  /**
   * Dismiss a pending manual event without firing. Operator chose not
   * to make up the missed slot; the row leaves the "pending" view.
   */
  .post("/dismiss", zValidator("json", ManualActionBodySchema), async (c) => {
    const { workspaceId, signalId, scheduledAt } = c.req.valid("json");
    const ctx = c.get("app");
    const nc = ctx.daemon.getNatsConnection();
    if (!nc) return c.json({ error: "NATS connection not ready" }, 503);
    const ok = await markEventDismissed(nc, workspaceId, signalId, scheduledAt);
    if (!ok) return c.json({ error: "Event not found or already fired/dismissed" }, 404);
    return c.json({ ok: true }, 200);
  })
  /**
   * Bulk action across every pending manual event for a (workspaceId,
   * signalId) pair. The /schedules UI rolls multiple missed slots
   * for the same signal into one row — this is the action surface
   * for that row's "Fire / Fire all / Dismiss" controls. Returns
   * the count of events transitioned + signals fired so the UI can
   * show "fired 3 of 4" or similar.
   */
  .post("/group", zValidator("json", GroupActionBodySchema), async (c) => {
    const { workspaceId, signalId, action } = c.req.valid("json");
    const ctx = c.get("app");
    const nc = ctx.daemon.getNatsConnection();
    if (!nc) return c.json({ error: "NATS connection not ready" }, 503);

    if (action === "dismiss-all") {
      const transitioned = await markAllPendingForSignal(nc, workspaceId, signalId, "dismissed");
      return c.json({ ok: true, dismissed: transitioned.length, fired: 0 }, 200);
    }

    // For both fire-once and fire-all we need to know how many
    // pending events exist (and their scheduledAt times for fire-all).
    // Mark them fired first, then publish signals — failing to publish
    // after marking fired is recoverable (operator can re-fire from a
    // new missed slot); failing to mark after publishing leaves
    // duplicate "pending" rows that look untouched.
    const transitioned = await markAllPendingForSignal(nc, workspaceId, signalId, "fired");
    if (transitioned.length === 0) {
      return c.json({ error: "No pending events for that signal" }, 404);
    }

    const firingsToPublish = action === "fire-all" ? transitioned : [transitioned[0]];
    let fired = 0;
    const errors: string[] = [];
    for (const scheduledAt of firingsToPublish) {
      try {
        await ctx.daemon.publishSignalToJetStream({
          workspaceId,
          signalId,
          payload: {
            source: "manual-make-up",
            scheduled: scheduledAt,
            actualFiredAt: new Date().toISOString(),
          },
        });
        fired++;
      } catch (err) {
        errors.push(String(err));
      }
    }

    return c.json(
      {
        ok: errors.length === 0,
        fired,
        marked: transitioned.length,
        ...(errors.length > 0 ? { errors } : {}),
      },
      200,
    );
  });
