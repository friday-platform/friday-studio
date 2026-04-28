/**
 * GET  /api/cron/timers                              — list all timers across all workspaces
 * POST /api/cron/timers/:workspaceId/:signalId/pause  — pause a schedule
 * POST /api/cron/timers/:workspaceId/:signalId/resume — resume a schedule
 */

import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { daemonFactory } from "../src/factory.ts";

const ParamSchema = z.object({
  workspaceId: z.string(),
  signalId: z.string(),
});

export const cronRoutes = daemonFactory
  .createApp()
  .get("/timers", async (c) => {
    const ctx = c.get("app");
    const cronManager = ctx.daemon.getCronManager();
    if (!cronManager) return c.json({ error: "Cron manager not ready" }, 503);

    const timers = cronManager.listTimers();

    // Enrich with workspace display names
    const workspaces = await ctx.getWorkspaceManager().list();
    const wsNames = new Map(workspaces.map((ws) => [ws.id, ws.name]));

    const enriched = timers.map((t) => ({
      workspaceId: t.workspaceId,
      workspaceName: wsNames.get(t.workspaceId) ?? t.workspaceId,
      signalId: t.signalId,
      schedule: t.schedule,
      timezone: t.timezone,
      nextExecution: t.nextExecution.toISOString(),
      lastExecution: t.lastExecution?.toISOString() ?? null,
      paused: t.paused ?? false,
    }));

    return c.json({ timers: enriched }, 200);
  })
  .post("/timers/:workspaceId/:signalId/pause", zValidator("param", ParamSchema), async (c) => {
    const { workspaceId, signalId } = c.req.valid("param");
    const ctx = c.get("app");
    const cronManager = ctx.daemon.getCronManager();
    if (!cronManager) return c.json({ error: "Cron manager not ready" }, 503);

    const found = await cronManager.setTimerPaused(workspaceId, signalId, true);
    if (!found) return c.json({ error: "Timer not found" }, 404);

    return c.json({ paused: true }, 200);
  })
  .post("/timers/:workspaceId/:signalId/resume", zValidator("param", ParamSchema), async (c) => {
    const { workspaceId, signalId } = c.req.valid("param");
    const ctx = c.get("app");
    const cronManager = ctx.daemon.getCronManager();
    if (!cronManager) return c.json({ error: "Cron manager not ready" }, 503);

    const found = await cronManager.setTimerPaused(workspaceId, signalId, false);
    if (!found) return c.json({ error: "Timer not found" }, 404);

    return c.json({ paused: false }, 200);
  });

export type CronRoutes = typeof cronRoutes;
