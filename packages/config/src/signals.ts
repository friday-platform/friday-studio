import { z } from "zod";
import { DurationSchema, SchemaObjectSchema } from "./base.ts";

/**
 * Per-signal concurrency policy. Controls what happens when a new
 * envelope for the same (workspace, signal) arrives while a previous
 * cascade is still running. Orthogonal to `onMissed` — that's the
 * downtime catch-up policy; this is the in-flight overlap policy.
 *
 * Applies uniformly to every signal provider (cron, HTTP, fs-watch,
 * slack, …). Read at dispatch time by the cascade consumer in
 * `apps/atlasd/src/cascade-stream.ts`.
 *
 * - `skip` (default) — drop the new envelope. Right for cron jobs
 *                      where missing one tick is fine because the next
 *                      tick will run; prevents pile-up if cascades
 *                      exceed the schedule.
 * - `queue`          — serialize: chain the new envelope to run after
 *                      the current one. Right when every tick must
 *                      eventually run in arrival order, but slow
 *                      cascades cause unbounded backlog.
 * - `concurrent`     — no overlap guard; fan out fully. Right for
 *                      stateless / idempotent jobs where parallel runs
 *                      are independent.
 * - `replace`        — singleton execution: abort the in-flight
 *                      cascade and start the new one. Right for
 *                      "freshest input wins" workloads (chat-style
 *                      cancel-in-flight semantics for non-chat signals).
 */
export const ConcurrencyPolicySchema = z.enum(["skip", "queue", "concurrent", "replace"]);
export type ConcurrencyPolicy = z.infer<typeof ConcurrencyPolicySchema>;

const BaseSignalConfigSchema = z.strictObject({
  description: z.string(),
  title: z
    .string()
    .optional()
    .describe("Short human-readable title in verb-noun format (e.g., 'Reads messages from Slack')"),
  schema: SchemaObjectSchema.optional().describe("JSON Schema for signal payload validation"),
  concurrency: ConcurrencyPolicySchema.optional().describe(
    "What to do when a new envelope for this signal arrives while a previous cascade " +
      "is still running. Defaults to 'skip'. Orthogonal to onMissed (which is the " +
      "downtime catch-up policy).",
  ),
});

export const HTTPProviderConfigSchema = z.strictObject({
  path: z.string().describe("HTTP path for the webhook (method is always POST)"),
  timeout: DurationSchema.optional().describe("Timeout for signal processing"),
});
export type HTTPProviderConfig = z.infer<typeof HTTPProviderConfigSchema>;

/**
 * Coalescing policy for missed cron firings.
 *
 * - `skip`     — drop missed firings entirely.
 * - `coalesce` — fire once now to represent every missed slot inside
 *                `missedWindow`. Payload carries `missedCount` +
 *                `firstMissedAt`. Right for "did this happen recently?"
 *                jobs (digests, syncs).
 * - `catchup`  — fire each missed slot in chronological order, one
 *                signal per slot. Right for "every tick must run"
 *                jobs (rate-limit accruals, time-series ingest).
 * - `manual`   — surface the missed slot in the /schedules UI as a
 *                pending row, do NOT fire automatically. The user
 *                clicks "Fire now" to trigger the signal explicitly.
 *                Right for jobs with expensive / visible side effects
 *                (paid API calls, email blasts, Slack posts) where you
 *                want oversight without auto-replay.
 *
 * Bounded by `missedWindow` regardless of policy: a daemon down for a
 * week on a `catchup` hourly cron only fires the slots inside the
 * window, not all 168.
 */
export const OnMissedPolicySchema = z.enum(["skip", "coalesce", "catchup", "manual"]);
export type OnMissedPolicy = z.infer<typeof OnMissedPolicySchema>;

export const ScheduleProviderConfigSchema = z.strictObject({
  schedule: z.string().describe("Cron expression (e.g., '0 9 * * *' for daily at 9 AM)"),
  timezone: z.string().optional().default("UTC").describe("Timezone for the schedule"),
  onMissed: OnMissedPolicySchema.optional().describe(
    "What to do with cron firings the daemon was down for. " +
      "manual = surface in /schedules UI as pending, do not auto-fire (DEFAULT); " +
      "skip = drop silently; coalesce = fire once now with missedCount; " +
      "catchup = fire each missed slot in order. Bounded by missedWindow.",
  ),
  missedWindow: DurationSchema.optional().describe(
    "How far back to consider missed firings. Slots older than now-missedWindow " +
      "are skipped regardless of policy. Defaults to 24h.",
  ),
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
    .describe(
      "Slack app ID — required for inbound webhook routing (matched against api_app_id). Populated by auto-wire for managed installs, or set explicitly for BYO.",
    ),
  bot_token: z
    .string()
    .optional()
    .describe(
      "Slack bot token (xoxb-...). Falls back to SLACK_BOT_TOKEN env var. When set, overrides any Link-managed credentials for this workspace.",
    ),
  signing_secret: z
    .string()
    .optional()
    .describe(
      "Slack signing secret for x-slack-signature verification. Falls back to SLACK_SIGNING_SECRET env var.",
    ),
  default_destination: z
    .string()
    .optional()
    .describe(
      "Default channel ID for outbound broadcasts (e.g. CXXXX for #ops). Used by job-output broadcast hook when this communicator is not the source of the triggering signal.",
    ),
});
export type SlackProviderConfig = z.infer<typeof SlackProviderConfigSchema>;

export const TelegramProviderConfigSchema = z.strictObject({
  bot_token: z
    .string()
    .optional()
    .describe("Telegram bot token. Falls back to TELEGRAM_BOT_TOKEN env var."),
  webhook_secret: z
    .string()
    .optional()
    .describe(
      "Webhook secret for x-telegram-bot-api-secret-token verification. Falls back to TELEGRAM_WEBHOOK_SECRET env var.",
    ),
  default_destination: z
    .string()
    .optional()
    .describe(
      "Default chat ID (numeric, as string) for outbound broadcasts. Positive for users, negative for groups.",
    ),
});
export type TelegramProviderConfig = z.infer<typeof TelegramProviderConfigSchema>;

export const DiscordProviderConfigSchema = z.strictObject({
  bot_token: z
    .string()
    .optional()
    .describe("Discord bot token. Falls back to DISCORD_BOT_TOKEN env var."),
  public_key: z
    .string()
    .optional()
    .describe(
      "Discord application public key (64-char hex). Falls back to DISCORD_PUBLIC_KEY env var.",
    ),
  application_id: z
    .string()
    .optional()
    .describe("Discord application ID. Falls back to DISCORD_APPLICATION_ID env var."),
  default_destination: z
    .string()
    .optional()
    .describe("Default channel ID for outbound broadcasts."),
});
export type DiscordProviderConfig = z.infer<typeof DiscordProviderConfigSchema>;

export const TeamsProviderConfigSchema = z.strictObject({
  app_id: z.string().optional().describe("Azure Bot App ID. Falls back to TEAMS_APP_ID env var."),
  app_password: z
    .string()
    .optional()
    .describe("Azure Bot client secret. Falls back to TEAMS_APP_PASSWORD env var."),
  app_tenant_id: z
    .string()
    .optional()
    .describe(
      "Azure AD tenant ID. Required for SingleTenant apps. Falls back to TEAMS_APP_TENANT_ID env var.",
    ),
  app_type: z
    .enum(["MultiTenant", "SingleTenant"])
    .optional()
    .describe("Azure Bot app type. Defaults to MultiTenant."),
  default_destination: z
    .string()
    .optional()
    .describe("Default conversation ID for outbound broadcasts."),
});
export type TeamsProviderConfig = z.infer<typeof TeamsProviderConfigSchema>;

export const WhatsAppProviderConfigSchema = z.strictObject({
  access_token: z
    .string()
    .optional()
    .describe(
      "Meta Graph API access token. Falls back to WHATSAPP_ACCESS_TOKEN env var. Prefer a permanent System User token for production.",
    ),
  app_secret: z
    .string()
    .optional()
    .describe(
      "Meta app secret used for X-Hub-Signature-256 verification. Falls back to WHATSAPP_APP_SECRET env var.",
    ),
  phone_number_id: z
    .string()
    .optional()
    .describe(
      "WhatsApp Business phone number ID from the Meta dashboard. Falls back to WHATSAPP_PHONE_NUMBER_ID env var.",
    ),
  verify_token: z
    .string()
    .optional()
    .describe(
      "User-defined secret string echoed back during Meta's GET verification handshake. Falls back to WHATSAPP_VERIFY_TOKEN env var.",
    ),
  api_version: z.string().optional().describe("Graph API version (defaults to v21.0 when omitted)"),
  default_destination: z
    .string()
    .optional()
    .describe(
      "Default WhatsApp recipient phone number for outbound broadcasts (E.164, e.g. +14155552671).",
    ),
});
export type WhatsAppProviderConfig = z.infer<typeof WhatsAppProviderConfigSchema>;

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

export const TelegramSignalConfigSchema = BaseSignalConfigSchema.extend({
  provider: z.literal("telegram"),
  config: TelegramProviderConfigSchema,
});

export const WhatsAppSignalConfigSchema = BaseSignalConfigSchema.extend({
  provider: z.literal("whatsapp"),
  config: WhatsAppProviderConfigSchema,
});

export const DiscordSignalConfigSchema = BaseSignalConfigSchema.extend({
  provider: z.literal("discord"),
  config: DiscordProviderConfigSchema,
});

export const TeamsSignalConfigSchema = BaseSignalConfigSchema.extend({
  provider: z.literal("teams"),
  config: TeamsProviderConfigSchema,
});

export const WorkspaceSignalConfigSchema = z.discriminatedUnion("provider", [
  HTTPSignalConfigSchema,
  ScheduleSignalConfigSchema,
  SystemSignalConfigSchema,
  FileWatchSignalConfigSchema,
  SlackSignalConfigSchema,
  TelegramSignalConfigSchema,
  WhatsAppSignalConfigSchema,
  DiscordSignalConfigSchema,
  TeamsSignalConfigSchema,
]);

export type WorkspaceSignalConfig = z.infer<typeof WorkspaceSignalConfigSchema>;

/** Loose patch body — merged result is validated against the full provider schema. */
export const SignalConfigPatchSchema = z.record(z.string(), z.unknown());

export type HTTPSignalConfig = z.infer<typeof HTTPSignalConfigSchema>;
export type ScheduleSignalConfig = z.infer<typeof ScheduleSignalConfigSchema>;
export type SystemSignalConfig = z.infer<typeof SystemSignalConfigSchema>;
export type SlackSignalConfig = z.infer<typeof SlackSignalConfigSchema>;
export type TelegramSignalConfig = z.infer<typeof TelegramSignalConfigSchema>;
export type WhatsAppSignalConfig = z.infer<typeof WhatsAppSignalConfigSchema>;
export type DiscordSignalConfig = z.infer<typeof DiscordSignalConfigSchema>;
export type TeamsSignalConfig = z.infer<typeof TeamsSignalConfigSchema>;

export const SignalTriggerRequestSchema = z.strictObject({
  payload: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Optional payload data for the signal"),
  streamId: z.string().optional().describe("Optional stream ID for UI progress feedback"),
});

export type SignalTriggerRequest = z.infer<typeof SignalTriggerRequestSchema>;
