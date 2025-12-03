/**
 * Slack type definitions and payload validation
 *
 * We trust Bolt to parse and deliver valid events from Socket Mode.
 * We only define Atlas-specific types, not Slack event types.
 */

import { z } from "zod";

// ==============================================================================
// ATLAS-SPECIFIC TYPES (for configuration and boundaries)
// ==============================================================================

/**
 * Slack channel types (raw values from Slack API)
 */
export type SlackChannelType = "im" | "channel" | "group" | "mpim" | "app_home";

/**
 * Channel filter options for signal configuration
 * "dm" is an alias for "im" to be more user-friendly in workspace.yml
 */
export type SlackChannelFilter = "dm" | "channel" | "group" | "mpim" | "app_home" | "all";

/**
 * Event types supported by Slack signals (for workspace.yml configuration)
 */
export type SlackEventType = "message" | "app_mention";

// ==============================================================================
// SIGNAL PAYLOAD (Boundary between Slack and Atlas workspaces)
// ==============================================================================

/**
 * Payload sent to Atlas workspaces when Slack signal triggers
 * This is our boundary - we validate when transforming from Slack events to workspace payloads
 */
export const SlackSignalPayloadSchema = z.strictObject({
  messageId: z.string().describe("Unique message identifier (ts)"),
  channelId: z.string().describe("Channel where message was sent"),
  channelType: z.enum(["im", "channel", "group", "mpim", "app_home"]).describe("Type of channel"),
  userId: z.string().optional().describe("User who sent message"),
  text: z.string().describe("Message text content"),
  timestamp: z.string().describe("Message timestamp"),
  threadTs: z.string().optional().describe("Thread parent timestamp if in thread"),
  teamId: z.string().optional().describe("Workspace/team ID"),
  isBot: z.boolean().describe("Whether message is from a bot"),
  botId: z.string().optional().describe("Bot ID if from bot"),
});

export type SlackSignalPayload = z.infer<typeof SlackSignalPayloadSchema>;
