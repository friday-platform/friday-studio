/**
 * Slack signal endpoint — receives events from Signal Gateway and dispatches
 * to the matching workspace runtime (same as cron/HTTP signals).
 */

import { logger } from "@atlas/logger";
import { Hono } from "hono";
import { z } from "zod";
import type { AtlasDaemon } from "../../src/atlas-daemon.ts";

const SlackSignalPayloadSchema = z.object({
  text: z.string(),
  _slack: z.object({
    channel_id: z.string(),
    team_id: z.string(),
    channel_type: z.enum(["im", "channel", "group", "mpim", "app_home"]),
    thread_ts: z.string().optional(),
    user_id: z.string(),
    timestamp: z.string(),
    app_id: z.string(),
  }),
});

export function createPlatformSignalRoutes(daemon: AtlasDaemon) {
  const app = new Hono();

  app.post("/slack", async (c) => {
    try {
      const body = await c.req.json();
      const payload = SlackSignalPayloadSchema.parse(body);

      const { app_id: appId } = payload._slack;

      logger.info("slack_signal_received", {
        appId,
        channelId: payload._slack.channel_id,
        teamId: payload._slack.team_id,
        channelType: payload._slack.channel_type,
      });

      const match = await findWorkspaceByAppId(daemon, appId);
      if (!match) {
        logger.warn("slack_no_workspace_for_app_id", { appId });
        return c.json({ error: "No workspace configured for this app_id" }, 404);
      }

      daemon.triggerWorkspaceSignal(match.workspaceId, match.signalId, payload).catch((error) => {
        logger.error("slack_signal_process_failed", { error, appId });
      });

      return c.json(null, 202);
    } catch (error) {
      logger.error("slack_signal_invalid_payload", { error });
      return c.json({ error: "Invalid payload" }, 400);
    }
  });

  return app;
}

async function findWorkspaceByAppId(
  daemon: AtlasDaemon,
  appId: string,
): Promise<{ workspaceId: string; signalId: string } | null> {
  const workspaces = await daemon.getWorkspaceManager().list();

  for (const ws of workspaces) {
    const config = await daemon.getWorkspaceManager().getWorkspaceConfig(ws.id);
    if (!config) continue;

    const signals = config.workspace.signals;
    if (!signals) continue;

    for (const [key, signal] of Object.entries(signals)) {
      if (signal.provider === "slack" && signal.config.app_id === appId) {
        return { workspaceId: ws.id, signalId: key };
      }
    }
  }

  return null;
}
