/**
 * @atlas/slack - Slack Socket Mode integration for Atlas
 */

// Re-export SlackSignalConfig type from @atlas/config
export type { SlackSignalConfig } from "@atlas/config";

// Public API
export { SlackIntegration } from "./src/integration.ts";
export { SlackSignalRegistrar } from "./src/registrar.ts";

// Atlas-specific types (configuration and boundary types)
export type {
  SlackChannelFilter,
  SlackChannelType,
  SlackEventType,
  SlackSignalPayload,
} from "./src/schemas.ts";

// Schema export (boundary validation)
export { SlackSignalPayloadSchema } from "./src/schemas.ts";

// Constants
export { SLACK_CONVERSATION_WORKSPACE_ID } from "./src/utils.ts";
