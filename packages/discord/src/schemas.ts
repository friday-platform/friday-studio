/**
 * Discord Integration - Zod Schemas and Type Definitions
 *
 * Runtime validation schemas for user input and external data.
 */

import type { APIUser } from "@discordjs/core";
import { z } from "zod";

/**
 * Parsed command options for /atlas chat
 * Validates user input from command options
 */
export const ChatCommandOptionsSchema = z.strictObject({
  message: z.string().min(1, "Message is required"),
});

export type ChatCommandOptions = z.infer<typeof ChatCommandOptionsSchema>;

/**
 * Discord metadata embedded in signal payload
 * This is added to signal payloads when triggered from Discord
 */
export const DiscordSignalMetadataSchema = z.strictObject({
  guildId: z.string().nullable(),
  channelId: z.string(),
  userId: z.string(),
  username: z.string(),
  discriminator: z.string(),
  timestamp: z.string().datetime(),
  interactionId: z.string(),
  interactionToken: z.string(),
});

export type DiscordSignalMetadata = z.infer<typeof DiscordSignalMetadataSchema>;

/**
 * Discord bot configuration from environment
 * Validates required environment variables
 */
export const DiscordBotConfigSchema = z.strictObject({
  botToken: z.string().min(1, "ATLAS_DISCORD_BOT_TOKEN is required"),
  applicationId: z.string().min(1, "ATLAS_DISCORD_APPLICATION_ID is required"),
  publicKey: z.string().min(1, "ATLAS_DISCORD_PUBLIC_KEY is required"),
});

/**
 * Parsed interaction with extracted command details
 * This is an internal representation after parsing raw Discord interaction
 * Used to simplify command handling logic
 *
 * TODO: Consider converting to Zod schema for runtime validation
 */
export interface ParsedInteraction {
  id: string;
  token: string;
  guildId: string | null;
  channelId: string;
  user: APIUser;
  command: string;
  subcommand?: string;
  options: Record<string, string | number | boolean>;
}
