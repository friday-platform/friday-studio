/**
 * Signal configuration schemas with tagged unions
 */

import { z } from "zod/v4";
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
    schedule: z.string().describe("Cron expression (e.g., '0 9 * * *' for daily at 9 AM)"),
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
]);

export type WorkspaceSignalConfig = z.infer<typeof WorkspaceSignalConfigSchema>;

// Type guards for signal types
export type HTTPSignalConfig = z.infer<typeof HTTPSignalConfigSchema>;
export type ScheduleSignalConfig = z.infer<typeof ScheduleSignalConfigSchema>;
export type SystemSignalConfig = z.infer<typeof SystemSignalConfigSchema>;

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
