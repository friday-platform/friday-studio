/**
 * Signal configuration schemas with tagged unions
 */

import { CronExpressionParser } from "cron-parser";
import { z } from "zod";
import { DurationSchema, SchemaObjectSchema } from "./base.ts";

// ==============================================================================
// BASE SIGNAL SCHEMA
// ==============================================================================

const BaseSignalConfigSchema = z.strictObject({
  description: z.string(),
  schema: SchemaObjectSchema.optional().describe("JSON Schema for signal payload validation"),
});

// ==============================================================================
// SIGNAL PROVIDER SCHEMAS
// ==============================================================================

/**
 * HTTP Signal - webhook/API endpoint
 */
export const HTTPSignalConfigSchema = BaseSignalConfigSchema.extend({
  provider: z.literal("http"),
  config: z.strictObject({
    path: z.string().describe("HTTP path for the webhook (method is always POST)"),
    timeout: DurationSchema.optional().describe("Timeout for signal processing"),
  }),
});

/**
 * Schedule Signal - cron-based triggers
 */
export const ScheduleSignalConfigSchema = BaseSignalConfigSchema.extend({
  provider: z.literal("schedule"),
  config: z.strictObject({
    schedule: z
      .string()
      .describe("Cron expression (e.g., '0 9 * * *' for daily at 9 AM)")
      .refine(
        (schedule) => {
          try {
            CronExpressionParser.parse(schedule);
            return true;
          } catch {
            return false;
          }
        },
        { message: "Invalid cron expression. Must be a valid cron format." },
      ),
    timezone: z.string().optional().default("UTC").describe("Timezone for the schedule"),
  }),
});

/**
 * System Signal - internal Atlas signals (system workspaces only)
 */
const SystemSignalConfigSchema = BaseSignalConfigSchema.extend({
  provider: z.literal("system"),
  // No additional config required for system signals
});

/**
 * File Watch Signal - filesystem change triggers
 */
export const FileWatchSignalConfigSchema = BaseSignalConfigSchema.extend({
  provider: z.literal("fs-watch"),
  config: z.strictObject({
    path: z.string().describe("Absolute or workspace-relative path to watch"),
    recursive: z
      .boolean()
      .optional()
      .default(true)
      .describe("Watch subdirectories when path is a directory"),
  }),
});

/**
 * Discord Signal - Discord message events
 * Triggered via Gateway WebSocket (MESSAGE_CREATE, MESSAGE_UPDATE)
 */
export const DiscordSignalConfigSchema = BaseSignalConfigSchema.extend({
  provider: z.literal("discord"),
  config: z.strictObject({
    /**
     * Events to listen for
     * - message_create: New messages
     * - message_update: Edited messages
     */
    events: z
      .array(z.enum(["message_create", "message_update"]))
      .min(1, "At least one event type required")
      .default(["message_create"]),

    /**
     * Channel filters
     * - dm: Direct messages only
     * - mention: @mentions only
     * - guild: Server messages (non-DM)
     * - all: All channels
     */
    channels: z
      .array(z.enum(["dm", "mention", "guild", "all"]))
      .min(1, "At least one channel type required")
      .default(["all"]),

    /**
     * Optional: Restrict to specific guilds (server IDs)
     */
    allowedGuilds: z.array(z.string()).optional(),
  }),
});

// ==============================================================================
// DISCRIMINATED UNION
// ==============================================================================

/**
 * Signal configuration with tagged union on provider type
 * Note: CLI is not a provider type - all signals can be triggered via CLI
 */
export const WorkspaceSignalConfigSchema = z.discriminatedUnion("provider", [
  HTTPSignalConfigSchema,
  ScheduleSignalConfigSchema,
  SystemSignalConfigSchema,
  FileWatchSignalConfigSchema,
  DiscordSignalConfigSchema,
]);

export type WorkspaceSignalConfig = z.infer<typeof WorkspaceSignalConfigSchema>;

// Type guards for signal types
export type HTTPSignalConfig = z.infer<typeof HTTPSignalConfigSchema>;
export type ScheduleSignalConfig = z.infer<typeof ScheduleSignalConfigSchema>;
export type SystemSignalConfig = z.infer<typeof SystemSignalConfigSchema>;
export type DiscordSignalConfig = z.infer<typeof DiscordSignalConfigSchema>;

// ==============================================================================
// SIGNAL TRIGGER SCHEMAS
// ==============================================================================

/**
 * Schema for signal trigger requests from tools/API
 */
export const SignalTriggerRequestSchema = z.strictObject({
  payload: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Optional payload data for the signal"),
  streamId: z.string().optional().describe("Optional stream ID for UI progress feedback"),
});

export type SignalTriggerRequest = z.infer<typeof SignalTriggerRequestSchema>;
