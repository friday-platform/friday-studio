/** Builds Slack app manifests for `apps.manifest.create`. */

/** Sentinel value for incomplete Slack app credentials awaiting OAuth completion. */
export const PENDING_TOKEN = "pending" as const;

const NAME_MAX = 35;
const DISPLAY_NAME_MAX = 80;
export const DESCRIPTION_MAX = 120;

const BOT_EVENTS = ["message.im", "app_mention"] as const;

export const BOT_SCOPES = [
  "chat:write",
  "chat:write.public",
  "app_mentions:read",
  "channels:history",
  "channels:read",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "im:write",
  "mpim:history",
  "mpim:read",
  "mpim:write",
  "users:read",
] as const;

/**
 * Converts an app name to a valid Slack bot display_name.
 * Allowed characters: a-z, 0-9, -, _, .
 */
export function toDisplayName(name: string): string {
  const sanitized = name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9\-_.]/g, "")
    .replace(/_{2,}/g, "_")
    .replace(/^[_.-]+|[_.-]+$/g, "")
    .slice(0, DISPLAY_NAME_MAX);
  return sanitized || "friday";
}

export interface EventSubscriptions {
  request_url: string;
  bot_events: string[];
}

export interface SlackManifest {
  display_information: { name: string; description: string };
  features: { bot_user: { display_name: string; always_online: boolean } };
  oauth_config: { scopes: { bot: string[] }; redirect_urls: string[] };
  settings: {
    org_deploy_enabled: boolean;
    socket_mode_enabled: boolean;
    token_rotation_enabled: boolean;
    event_subscriptions?: EventSubscriptions;
  };
}

/** Builds a Slack app manifest for app creation. */
export function buildManifest(params: {
  appName: string;
  description: string;
  callbackUrl: string;
}): SlackManifest {
  const { appName, description, callbackUrl } = params;

  return {
    display_information: {
      name: appName.slice(0, NAME_MAX),
      description: description.slice(0, DESCRIPTION_MAX),
    },
    features: { bot_user: { display_name: toDisplayName(appName), always_online: true } },
    oauth_config: { scopes: { bot: [...BOT_SCOPES] }, redirect_urls: [callbackUrl] },
    settings: {
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}

/** Uses Record<string, unknown> because Slack-exported manifests have extra fields. */
export function withEventSubscriptions(
  manifest: Record<string, unknown>,
  webhookUrl: string | null,
): Record<string, unknown> {
  const existingSettings = (manifest.settings ?? {}) as Record<string, unknown>;
  const settings = { ...existingSettings };
  if (webhookUrl) {
    settings.event_subscriptions = { request_url: webhookUrl, bot_events: [...BOT_EVENTS] };
  } else {
    delete settings.event_subscriptions;
  }
  return { ...manifest, settings };
}
