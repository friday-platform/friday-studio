/**
 * Notification configuration schemas
 */

import { z } from "zod/v4";
import { DurationSchema } from "./base.ts";

// ==============================================================================
// BASE NOTIFICATION SCHEMAS
// ==============================================================================

/**
 * Base notification provider schema with common fields
 */
const BaseNotificationProviderSchema = z.strictObject({
  enabled: z.boolean().default(true).describe("Whether this provider is enabled"),
  description: z.string().optional().describe("Human-readable description of this provider"),
});

/**
 * Email parameters schema
 */
export const EmailParamsSchema = z.strictObject({
  to: z.union([z.string().email(), z.array(z.string().email())]).describe(
    "Recipient email address(es)",
  ),
  subject: z.string().describe("Email subject line"),
  content: z.string().describe("Email content (HTML or plain text)"),
  from: z.string().email().optional().describe("Override sender email"),
  from_name: z.string().optional().describe("Override sender name"),
  template_id: z.string().optional().describe("Template ID for provider-specific templates"),
  template_data: z.record(z.string(), z.unknown()).optional().describe("Template variables"),
  attachments: z.array(z.strictObject({
    filename: z.string().describe("Attachment filename"),
    content: z.string().describe("Base64 encoded attachment content"),
    type: z.string().describe("MIME type"),
    disposition: z.enum(["attachment", "inline"]).default("attachment"),
  })).optional().describe("Email attachments"),
});

/**
 * Generic message parameters schema
 */
export const MessageParamsSchema = z.strictObject({
  content: z.string().describe("Message content"),
  channel: z.string().optional().describe("Target channel or recipient"),
  metadata: z.record(z.string(), z.unknown()).optional().describe("Provider-specific metadata"),
});

/**
 * Notification result schema
 */
export const NotificationResultSchema = z.strictObject({
  success: z.boolean().describe("Whether the notification was sent successfully"),
  message_id: z.string().optional().describe("Provider-specific message ID"),
  error: z.string().optional().describe("Error message if failed"),
  retry_count: z.number().int().min(0).optional().describe("Number of retry attempts made"),
  metadata: z.record(z.string(), z.unknown()).optional().describe("Provider-specific metadata"),
});

// ==============================================================================
// PROVIDER SCHEMAS
// ==============================================================================

/**
 * SendGrid provider configuration
 */
const SendGridProviderSchema = BaseNotificationProviderSchema.extend({
  provider: z.literal("sendgrid"),
  config: z.strictObject({
    api_key_env: z.string().describe("Environment variable containing SendGrid API key"),
    from_email: z.string().email().describe("Default from email address"),
    from_name: z.string().optional().describe("Default from name"),
    template_id: z.string().optional().describe("Default template ID"),
    timeout: DurationSchema.optional().default("30s").describe("Request timeout"),
    sandbox_mode: z.boolean().optional().default(false).describe("Enable sandbox mode for testing"),
  }),
});

/**
 * Slack provider configuration
 */
const SlackProviderSchema = BaseNotificationProviderSchema.extend({
  provider: z.literal("slack"),
  config: z.strictObject({
    webhook_url_env: z.string().describe("Environment variable containing Slack webhook URL"),
    channel: z.string().optional().describe("Default channel (e.g., '#general')"),
    username: z.string().optional().describe("Bot username"),
    icon_emoji: z.string().optional().describe("Bot icon emoji"),
    timeout: DurationSchema.optional().default("30s").describe("Request timeout"),
  }),
});

/**
 * Microsoft Teams provider configuration
 */
const TeamsProviderSchema = BaseNotificationProviderSchema.extend({
  provider: z.literal("teams"),
  config: z.strictObject({
    webhook_url_env: z.string().describe("Environment variable containing Teams webhook URL"),
    timeout: DurationSchema.optional().default("30s").describe("Request timeout"),
  }),
});

/**
 * Discord provider configuration
 */
const DiscordProviderSchema = BaseNotificationProviderSchema.extend({
  provider: z.literal("discord"),
  config: z.strictObject({
    webhook_url_env: z.string().describe("Environment variable containing Discord webhook URL"),
    username: z.string().optional().describe("Bot username"),
    avatar_url: z.string().url().optional().describe("Bot avatar URL"),
    timeout: DurationSchema.optional().default("30s").describe("Request timeout"),
  }),
});

/**
 * Discriminated union for notification providers
 */
export const NotificationProviderSchema = z.discriminatedUnion("provider", [
  SendGridProviderSchema,
  SlackProviderSchema,
  TeamsProviderSchema,
  DiscordProviderSchema,
]);

// ==============================================================================
// MAIN NOTIFICATION CONFIGURATION
// ==============================================================================

/**
 * Notification defaults configuration
 */
export const NotificationDefaultsSchema = z.strictObject({
  enabled: z.boolean().default(true).describe("Whether notifications are enabled by default"),
  provider: z.string().optional().describe("Default provider name to use"),
  retry_attempts: z.number().int().min(0).max(10).default(3).describe(
    "Default number of retry attempts",
  ),
  retry_delay: DurationSchema.default("5s").describe("Default delay between retry attempts"),
  retry_backoff: z.number().min(1).max(10).default(2).describe("Retry backoff multiplier"),
  timeout: DurationSchema.default("30s").describe("Default request timeout"),
});

/**
 * Main notification configuration schema
 */
export const NotificationConfigSchema = z.strictObject({
  providers: z.record(z.string(), NotificationProviderSchema).optional().describe(
    "Notification providers by name",
  ),
  defaults: NotificationDefaultsSchema.optional().describe("Default notification settings"),
});

// ==============================================================================
// TYPE EXPORTS
// ==============================================================================

export type NotificationConfig = z.infer<typeof NotificationConfigSchema>;
export type NotificationProvider = z.infer<typeof NotificationProviderSchema>;
export type NotificationDefaults = z.infer<typeof NotificationDefaultsSchema>;
export type EmailParams = z.infer<typeof EmailParamsSchema>;
export type MessageParams = z.infer<typeof MessageParamsSchema>;
export type NotificationResult = z.infer<typeof NotificationResultSchema>;

// Provider-specific types
export type SendGridProvider = z.infer<typeof SendGridProviderSchema>;
export type SlackProvider = z.infer<typeof SlackProviderSchema>;
export type TeamsProvider = z.infer<typeof TeamsProviderSchema>;
export type DiscordProvider = z.infer<typeof DiscordProviderSchema>;
