import { stringifyError } from "@atlas/utils";
import { CronExpressionParser } from "cron-parser";
import { z } from "zod";
import { DurationSchema, SchemaObjectSchema } from "./base.ts";

const BaseSignalConfigSchema = z.strictObject({
  description: z.string(),
  title: z
    .string()
    .optional()
    .describe("Short human-readable title in verb-noun format (e.g., 'Reads messages from Slack')"),
  schema: SchemaObjectSchema.optional().describe("JSON Schema for signal payload validation"),
});

export const HTTPProviderConfigSchema = z.strictObject({
  path: z.string().describe("HTTP path for the webhook (method is always POST)"),
  timeout: DurationSchema.optional().describe("Timeout for signal processing"),
});
export type HTTPProviderConfig = z.infer<typeof HTTPProviderConfigSchema>;

export const ScheduleProviderConfigSchema = z.strictObject({
  schedule: z
    .string()
    .describe("Cron expression (e.g., '0 9 * * *' for daily at 9 AM)")
    .superRefine((schedule, ctx) => {
      try {
        CronExpressionParser.parse(schedule);
      } catch (err) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Invalid cron expression: ${stringifyError(err)}`,
        });
      }
    }),
  timezone: z.string().optional().default("UTC").describe("Timezone for the schedule"),
});
export type ScheduleProviderConfig = z.infer<typeof ScheduleProviderConfigSchema>;

export const FSWatchProviderConfigSchema = z.strictObject({
  path: z.string().describe("Absolute or workspace-relative path to watch"),
  recursive: z
    .boolean()
    .optional()
    .default(true)
    .describe("Watch subdirectories when path is a directory"),
});
export type FSWatchProviderConfig = z.infer<typeof FSWatchProviderConfigSchema>;

export const SlackProviderConfigSchema = z.strictObject({
  app_id: z
    .string()
    .optional()
    .describe("Slack app ID — populated by auto-wire after workspace creation"),
});
export type SlackProviderConfig = z.infer<typeof SlackProviderConfigSchema>;

export const HTTPSignalConfigSchema = BaseSignalConfigSchema.extend({
  provider: z.literal("http"),
  config: HTTPProviderConfigSchema,
});

export const ScheduleSignalConfigSchema = BaseSignalConfigSchema.extend({
  provider: z.literal("schedule"),
  config: ScheduleProviderConfigSchema,
});

const SystemSignalConfigSchema = BaseSignalConfigSchema.extend({ provider: z.literal("system") });

export const FileWatchSignalConfigSchema = BaseSignalConfigSchema.extend({
  provider: z.literal("fs-watch"),
  config: FSWatchProviderConfigSchema,
});

export const SlackSignalConfigSchema = BaseSignalConfigSchema.extend({
  provider: z.literal("slack"),
  config: SlackProviderConfigSchema,
});

export const WorkspaceSignalConfigSchema = z.discriminatedUnion("provider", [
  HTTPSignalConfigSchema,
  ScheduleSignalConfigSchema,
  SystemSignalConfigSchema,
  FileWatchSignalConfigSchema,
  SlackSignalConfigSchema,
]);

export type WorkspaceSignalConfig = z.infer<typeof WorkspaceSignalConfigSchema>;

/** Loose patch body — merged result is validated against the full provider schema. */
export const SignalConfigPatchSchema = z.record(z.string(), z.unknown());

export type HTTPSignalConfig = z.infer<typeof HTTPSignalConfigSchema>;
export type ScheduleSignalConfig = z.infer<typeof ScheduleSignalConfigSchema>;
export type SystemSignalConfig = z.infer<typeof SystemSignalConfigSchema>;
export type SlackSignalConfig = z.infer<typeof SlackSignalConfigSchema>;

export const SignalTriggerRequestSchema = z.strictObject({
  payload: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Optional payload data for the signal"),
  streamId: z.string().optional().describe("Optional stream ID for UI progress feedback"),
});

export type SignalTriggerRequest = z.infer<typeof SignalTriggerRequestSchema>;
