/**
 * Slack signal endpoint - responds directly to Slack.
 *
 * Receives Slack events from Signal Gateway with:
 * - text: User message
 * - _slack: Platform context for routing responses
 *
 * Atlas:
 * 1. Returns 202 immediately
 * 2. Processes signal asynchronously
 * 3. Posts response directly to Slack using team-scoped bot token
 */

import { ChatStorage } from "@atlas/core/chat/storage";
import { logger } from "@atlas/logger";
import { Hono } from "hono";
import { z } from "zod";
import {
  generateSlackChatId,
  initializePlatformChat,
} from "../../../../src/core/platform-utils.ts";
import type { AtlasDaemon } from "../../src/atlas-daemon.ts";
import { postSlackMessage } from "../../src/services/slack-client.ts";
import { getSlackTokenByTeamId } from "../../src/services/slack-credentials.ts";

// ==============================================================================
// SCHEMAS
// ==============================================================================

const SlackSignalPayloadSchema = z.object({
  text: z.string(),
  _slack: z.object({
    channel_id: z.string(),
    team_id: z.string(),
    channel_type: z.enum(["im", "channel", "group", "mpim", "app_home"]),
    thread_ts: z.string().optional(),
    user_id: z.string(),
    timestamp: z.string(),
  }),
});

type SlackSignalPayload = z.infer<typeof SlackSignalPayloadSchema>;

// ==============================================================================
// ROUTES
// ==============================================================================

export function createPlatformSignalRoutes(daemon: AtlasDaemon) {
  const app = new Hono();

  /**
   * POST /signals/slack
   * Receives Slack events from Signal Gateway
   */
  app.post("/slack", async (c) => {
    try {
      const body = await c.req.json();
      const payload = SlackSignalPayloadSchema.parse(body);

      logger.info("Received Slack signal from gateway", {
        channelId: payload._slack.channel_id,
        teamId: payload._slack.team_id,
        channelType: payload._slack.channel_type,
      });

      // Route to atlas-conversation workspace
      const workspaceId = "atlas-conversation";
      const signalId = "slack"; // Renamed from slack-dm

      // Queue async processing
      processSlackSignal(daemon, workspaceId, signalId, payload).catch((error) => {
        logger.error("Failed to process Slack signal", { error, payload });
      });

      // Return 202 immediately
      return c.json(null, 202);
    } catch (error) {
      logger.error("Invalid Slack signal payload", { error });
      return c.json({ error: "Invalid payload" }, 400);
    }
  });

  return app;
}

// ==============================================================================
// ASYNC PROCESSORS
// ==============================================================================

/**
 * Process Slack signal asynchronously
 */
async function processSlackSignal(
  daemon: AtlasDaemon,
  workspaceId: string,
  signalId: string,
  payload: SlackSignalPayload,
): Promise<void> {
  const { team_id, channel_id, channel_type, thread_ts, user_id, timestamp } = payload._slack;

  // Threading: DMs = no thread, channels = always thread
  const isDM = channel_type === "im";
  const replyThreadTs = isDM ? undefined : (thread_ts ?? timestamp);

  // Look up Slack token from Link API
  // Returns null if no credential configured (handled below)
  // Throws on Link API failure → caught by outer handler (line 71)
  const slackToken = await getSlackTokenByTeamId(team_id);
  if (!slackToken) {
    logger.warn("slack_integration_not_configured", { team_id });
    return; // Silent fail - no Slack connected for this team
  }

  // Generate chat ID
  const chatId = await generateSlackChatId(team_id, channel_id, user_id);

  // Initialize chat storage
  const chatResult = await initializePlatformChat(
    chatId,
    user_id,
    workspaceId,
    payload.text,
    "slack",
  );
  if (!chatResult.ok) {
    throw new Error(`Failed to initialize chat: ${chatResult.error}`);
  }

  // Trigger signal - blocks until FSM completion
  const result = await daemon.triggerWorkspaceSignal(workspaceId, signalId, {
    ...payload,
    chatId,
    sessionId: chatId,
  });

  // Read response from chat storage (same pattern as web UI)
  const storedChat = await ChatStorage.getChat(chatId);
  let responseText = "No response generated";

  if (storedChat.ok && storedChat.data) {
    // Find last assistant message
    const messages = storedChat.data.messages;
    const lastAssistantMessage = [...messages].reverse().find((m) => m.role === "assistant");

    if (lastAssistantMessage) {
      // Extract text from message parts
      const textParts = lastAssistantMessage.parts
        .filter((p): p is { type: "text"; text: string } => p.type === "text" && "text" in p)
        .map((p) => p.text);
      responseText = textParts.join("") || responseText;
    }
  }

  // Reply to Slack - throws on API error
  await postSlackMessage({
    token: slackToken,
    channel: channel_id,
    text: responseText,
    threadTs: replyThreadTs,
  });

  logger.info("slack_signal_processed", {
    chatId,
    sessionId: result.sessionId,
    responseLength: responseText.length,
  });
}
