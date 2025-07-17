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
const HTTPSignalConfigSchema = BaseSignalConfigSchema.extend({
  provider: z.literal("http"),
  config: z.strictObject({
    path: z.string().describe("HTTP path for the webhook (method is always POST)"),
    timeout: DurationSchema.optional().describe("Timeout for signal processing"),
  }),
});

/**
 * Schedule Signal - cron-based triggers
 */
const ScheduleSignalConfigSchema = BaseSignalConfigSchema.extend({
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
]);

export type WorkspaceSignalConfig = z.infer<typeof WorkspaceSignalConfigSchema>;

// Type guards for signal types
export type HTTPSignalConfig = z.infer<typeof HTTPSignalConfigSchema>;
export type ScheduleSignalConfig = z.infer<typeof ScheduleSignalConfigSchema>;
export type SystemSignalConfig = z.infer<typeof SystemSignalConfigSchema>;
