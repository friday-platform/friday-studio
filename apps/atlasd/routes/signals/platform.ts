/**
 * Slack signal endpoint for Signal Gateway integration.
 *
 * Signal Gateway POSTs Slack events to this endpoint with:
 * - text: User message
 * - callback_url: Where to send response
 * - _slack: Platform context for routing responses
 *
 * Atlas MUST:
 * 1. Return 202 immediately (within 10s)
 * 2. Process signal asynchronously
 * 3. POST response to callback_url with platform context echoed back
 */

import { logger } from "@atlas/logger";
import { Hono } from "hono";
import { z } from "zod";
import {
  generateSlackChatId,
  initializePlatformChat,
} from "../../../../src/core/platform-utils.ts";
import type { AtlasDaemon } from "../../src/atlas-daemon.ts";

// ==============================================================================
// SCHEMAS
// ==============================================================================

const SlackSignalPayloadSchema = z.object({
  text: z.string(),
  callback_url: z.string().url().optional(),
  _slack: z.object({
    channel_id: z.string(),
    team_id: z.string(),
    channel_type: z.enum(["dm", "channel", "group", "mpim", "app_home"]),
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
        hasCallback: !!payload.callback_url,
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
  try {
    // Generate deterministic chat ID
    const chatId = await generateSlackChatId(
      payload._slack.team_id,
      payload._slack.channel_id,
      payload._slack.user_id,
    );

    // Initialize chat storage
    const chatResult = await initializePlatformChat(
      chatId,
      payload._slack.user_id,
      workspaceId,
      payload.text,
    );

    if (!chatResult.ok) {
      throw new Error(`Failed to initialize chat: ${chatResult.error}`);
    }

    // Trigger workspace signal
    const streamId = crypto.randomUUID();
    let accumulatedText = "";

    const result = await daemon.triggerWorkspaceSignal(
      workspaceId,
      signalId,
      { ...payload, chatId, sessionId: chatId },
      streamId,
      (chunk) => {
        // @ts-expect-error - chunk types from ai SDK are complex, checking for text parts
        if (chunk.type === "text" && chunk.text) {
          // @ts-expect-error - dynamic property access
          accumulatedText += chunk.text;
        }
      },
    );

    // Wait for completion
    const completed = await daemon.waitForSignalCompletion(workspaceId, result.sessionId, 300_000);

    if (!completed) {
      throw new Error("Signal processing timed out");
    }

    // Send callback to gateway
    if (payload.callback_url) {
      await sendGatewayCallback(payload.callback_url, {
        text: accumulatedText || "No response generated",
        status: "success",
        // Flatten platform context fields (Go handler expects root-level)
        channel_id: payload._slack.channel_id,
        thread_ts: payload._slack.thread_ts,
      });
    }

    logger.info("Slack signal processed successfully", {
      chatId,
      sessionId: result.sessionId,
      responseLength: accumulatedText.length,
    });
  } catch (error) {
    logger.error("Slack signal processing failed", { error, payload });

    if (payload.callback_url) {
      await sendGatewayCallback(payload.callback_url, {
        error: error instanceof Error ? error.message : "Unknown error",
        status: "failed",
        // Flatten platform context fields (Go handler expects root-level)
        channel_id: payload._slack.channel_id,
        thread_ts: payload._slack.thread_ts,
      }).catch((e) => logger.error("Failed to send error callback", { error: e }));
    }
  }
}

// ==============================================================================
// CALLBACK HELPER
// ==============================================================================

/**
 * Send callback to Signal Gateway
 *
 * Gateway expects flat structure:
 * - text or error: Response content
 * - status: "success" | "failed"
 * - channel_id: Slack channel ID
 * - thread_ts: Optional thread timestamp
 *
 * Retry logic: Atlas retries 1x with 5s backoff, then logs error
 */
const CALLBACK_TIMEOUT_MS = 10_000; // 10 seconds

async function sendGatewayCallback(
  callbackUrl: string,
  body: Record<string, unknown>,
  retries = 1,
): Promise<void> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(`Gateway callback failed: ${response.status} ${response.statusText}`);
      }

      return; // Success
    } catch (error) {
      if (attempt < retries) {
        logger.warn("Gateway callback failed, retrying", { attempt, error });
        await new Promise((resolve) => setTimeout(resolve, 5000)); // 5s backoff
      } else {
        throw error; // Final attempt failed
      }
    }
  }
}
