/**
 * Atlas Notifications Package
 *
 * Provides notification capabilities for Atlas workspaces with support for
 * multiple providers including SendGrid, Slack, Discord, and Microsoft Teams.
 */

// Core types and interfaces
export * from "./src/types.ts";

// Notification manager
export { NotificationManager } from "./src/notification-manager.ts";

// Base provider
export { BaseNotificationProvider } from "./src/providers/base-provider.ts";

// Providers
export { SendGridProvider } from "./src/providers/sendgrid-provider.ts";

// Provider factory and registry
export {
  DefaultNotificationProviderFactory,
  defaultProviderRegistry,
  ProviderRegistry,
} from "./src/providers/provider-factory.ts";

// Re-export configuration types and schemas from @atlas/config
export type {
  DiscordProvider as DiscordProviderConfig,
  EmailParams,
  MessageParams,
  NotificationConfig,
  NotificationDefaults,
  NotificationProvider as NotificationProviderConfig,
  NotificationResult,
  SendGridProvider as SendGridProviderConfig,
  SlackProvider as SlackProviderConfig,
  TeamsProvider as TeamsProviderConfig,
} from "@atlas/config";

// Re-export configuration schemas from @atlas/config
export {
  EmailParamsSchema,
  MessageParamsSchema,
  NotificationConfigSchema,
  NotificationDefaultsSchema,
  NotificationProviderSchema,
  NotificationResultSchema,
} from "@atlas/config";
