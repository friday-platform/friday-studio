/**
 * Tests for SlackEventRouter
 *
 * Covers ATLAS-1J: ZodError when Slack sends messages without text field
 * (message_changed, message_deleted, etc.)
 *
 * Test fixtures use official Slack types from @slack/types to ensure conformance.
 * @see https://github.com/slackapi/node-slack-sdk/blob/8ec90150d52c12eea3379fb004ee429e05f16a94/packages/types/src/events/message.ts
 */

import type { Logger } from "@atlas/logger";
import type { BotMessageEvent, GenericMessageEvent, MessageChangedEvent } from "@slack/types";
import type { WebClient } from "@slack/web-api";
import { assertEquals, assertExists } from "@std/assert";
import { SlackEventRouter } from "./event-router.ts";
import type { SlackSignalMetadata, SlackSignalRegistrar } from "./registrar.ts";
import type { SlackSignalPayload } from "./schemas.ts";

// Mock logger that captures calls
function createMockLogger(): Logger & { debugCalls: unknown[] } {
  const debugCalls: unknown[] = [];
  return {
    debugCalls,
    debug: (...args: unknown[]) => {
      debugCalls.push(args);
    },
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => createMockLogger(),
  } as unknown as Logger & { debugCalls: unknown[] };
}

// Mock registrar that returns configurable matches
function createMockRegistrar(matchingSignals: SlackSignalMetadata[] = []): SlackSignalRegistrar {
  return {
    findMatchingSignals: () => matchingSignals,
    registerWorkspace: () => {},
    unregisterWorkspace: () => {},
    shutdown: () => Promise.resolve(),
  } as unknown as SlackSignalRegistrar;
}

// Track signal triggers
interface SignalTrigger {
  workspaceId: string;
  signalId: string;
  payload: SlackSignalPayload;
}

// Setup helper to reduce test boilerplate
function setupRouter(signals: SlackSignalMetadata[] = []) {
  const logger = createMockLogger();
  const triggers: SignalTrigger[] = [];
  const router = new SlackEventRouter({
    logger,
    registrar: createMockRegistrar(signals),
    onSignalTrigger: async (workspaceId, signalId, payload) => {
      triggers.push({ workspaceId, signalId, payload });
    },
    boltClient: {} as WebClient,
  });
  return { logger, triggers, router };
}

// Default signal config for most tests
const defaultSignal: SlackSignalMetadata = {
  workspaceId: "ws-1",
  signalId: "sig-1",
  config: { events: ["message"], channels: ["all"], ignoreBotMessages: false },
};

Deno.test("routeEvent - skips message_changed events (no top-level text)", async () => {
  const { logger, triggers, router } = setupRouter([defaultSignal]);

  // Simulate message_changed event - text is nested in message.text, not at top level
  // Using official Slack type to ensure conformance
  const messageChangedEvent: MessageChangedEvent = {
    type: "message",
    subtype: "message_changed",
    event_ts: "1234567890.000001",
    hidden: true,
    channel: "C123",
    channel_type: "channel",
    ts: "1234567890.000001",
    message: {
      type: "message",
      subtype: undefined,
      event_ts: "1234567890.000000",
      channel: "C123",
      channel_type: "channel",
      user: "U123",
      text: "edited text",
      ts: "1234567890.000000",
    },
    previous_message: {
      type: "message",
      subtype: undefined,
      event_ts: "1234567890.000000",
      channel: "C123",
      channel_type: "channel",
      user: "U123",
      text: "original text",
      ts: "1234567890.000000",
    },
    // Note: NO top-level "text" field - this is what causes the ZodError
  };

  await router.routeEvent(messageChangedEvent, { teamId: "T123", eventId: "E123" });

  // Should NOT trigger any signals
  assertEquals(triggers.length, 0, "message_changed should not trigger signals");

  // Should log debug message
  const debugLog = logger.debugCalls.find(
    (call) => Array.isArray(call) && call[0] === "Skipping event without text",
  );
  assertExists(debugLog, "Should log skipped event");
});

Deno.test("routeEvent - processes regular messages with text", async () => {
  const { triggers, router } = setupRouter([defaultSignal]);

  // Regular message with text
  // Using official Slack type to ensure conformance
  const regularMessage: GenericMessageEvent = {
    type: "message",
    subtype: undefined,
    event_ts: "1234567890.000003",
    channel: "C123",
    channel_type: "channel",
    user: "U123",
    text: "Hello, world!",
    ts: "1234567890.000003",
  };

  await router.routeEvent(regularMessage, { teamId: "T123", eventId: "E125" });

  assertEquals(triggers.length, 1, "Regular message should trigger signal");
  assertEquals(triggers[0]?.payload.text, "Hello, world!");
  assertEquals(triggers[0]?.payload.channelId, "C123");
  assertEquals(triggers[0]?.payload.userId, "U123");
});

// Signal config for app_mention tests
const appMentionSignal: SlackSignalMetadata = {
  workspaceId: "ws-1",
  signalId: "sig-1",
  config: { events: ["app_mention"], channels: ["all"], ignoreBotMessages: false },
};

Deno.test("routeEvent - processes app_mention with text", async () => {
  const { triggers, router } = setupRouter([appMentionSignal]);

  // Valid app_mention
  const appMention = {
    type: "app_mention",
    channel: "C123",
    user: "U123",
    text: "<@U456> help me",
    ts: "1234567890.000005",
  };

  await router.routeEvent(appMention, { teamId: "T123", eventId: "E127" });

  assertEquals(triggers.length, 1, "Valid app_mention should trigger signal");
  assertEquals(triggers[0]?.payload.text, "<@U456> help me");
});

Deno.test("routeEvent - processes bot_message with text", async () => {
  const { triggers, router } = setupRouter([defaultSignal]);

  // Bot message with text
  // Using official Slack type to ensure conformance
  const botMessageWithText: BotMessageEvent = {
    type: "message",
    subtype: "bot_message",
    event_ts: "1234567890.000007",
    channel: "C123",
    channel_type: "channel",
    bot_id: "B123",
    text: "Automated notification",
    ts: "1234567890.000007",
  };

  await router.routeEvent(botMessageWithText, { teamId: "T123", eventId: "E129" });

  assertEquals(triggers.length, 1, "Bot message with text should trigger");
  assertEquals(triggers[0]?.payload.text, "Automated notification");
  assertEquals(triggers[0]?.payload.isBot, true);
  assertEquals(triggers[0]?.payload.botId, "B123");
});
