/**
 * Slack signal endpoint — receives raw Slack events from Signal Gateway
 * and delegates to the workspace's Chat SDK SlackAdapter (which handles
 * signature verification, parsing, and dispatch).
 */

import { createLogger } from "@atlas/logger";
import type { Chat } from "chat";
import { Hono } from "hono";
import { z } from "zod";
import type { AtlasDaemon } from "../../src/atlas-daemon.ts";

const logger = createLogger({ component: "platform-signal-route" });

const SlackAppIdSchema = z.object({ api_app_id: z.string() });

export function createPlatformSignalRoutes(daemon: AtlasDaemon) {
  const app = new Hono();

  app.post("/slack", async (c) => {
    // Clone before consuming — SlackAdapter needs the raw body for sig verification
    const slackRequest = c.req.raw.clone();
    const rawBody = await c.req.text();

    let appId: string;
    try {
      appId = SlackAppIdSchema.parse(JSON.parse(rawBody)).api_app_id;
    } catch {
      logger.warn("slack_signal_missing_app_id", { bodyPreview: rawBody.slice(0, 200) });
      return c.json({ error: "Missing api_app_id in payload" }, 400);
    }

    logger.info("slack_signal_received", { appId });

    const workspaceId = await findWorkspaceByAppId(daemon, appId);
    if (!workspaceId) {
      logger.warn("slack_no_workspace_for_app_id", { appId });
      return c.json({ error: "No workspace configured for this app_id" }, 404);
    }

    let chat: Chat;
    try {
      chat = (await daemon.getOrCreateChatSdkInstance(workspaceId)).chat;
    } catch (error) {
      logger.error("slack_chat_sdk_instance_failed", { error, workspaceId, appId });
      return c.json({ error: "Failed to initialize Chat SDK" }, 500);
    }

    if (!chat.webhooks.slack) {
      logger.warn("slack_no_adapter_for_workspace", { workspaceId, appId });
      return c.json({ error: "No Slack adapter configured for this workspace" }, 404);
    }

    try {
      return await chat.webhooks.slack(slackRequest);
    } catch (error) {
      logger.error("slack_webhook_handler_failed", { error, workspaceId, appId });
      return new Response("Internal error", { status: 500 });
    }
  });

  return app;
}

async function findWorkspaceByAppId(daemon: AtlasDaemon, appId: string): Promise<string | null> {
  const workspaces = await daemon.getWorkspaceManager().list();

  for (const ws of workspaces) {
    const config = await daemon.getWorkspaceManager().getWorkspaceConfig(ws.id);
    if (!config) continue;

    const signals = config.workspace.signals;
    if (!signals) continue;

    for (const signal of Object.values(signals)) {
      if (signal.provider === "slack" && signal.config.app_id === appId) {
        return ws.id;
      }
    }
  }

  return null;
}
