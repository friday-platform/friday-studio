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
  "reactions:write",
  "users:read",
] as const;

/**
 * Sanitizes an app name for use as a Slack bot display_name.
 * Preserves original casing and spaces. Strips characters outside
 * the allowed set: letters, digits, spaces, hyphens, underscores, dots.
 */
export function toDisplayName(name: string): string {
  const sanitized = name
    .trim()
    .replace(/[^a-zA-Z0-9 \-_.]/g, "")
    .replace(/ {2,}/g, " ")
    .trim()
    .slice(0, DISPLAY_NAME_MAX);
  return sanitized || "friday";
}

export interface EventSubscriptions {
  request_url: string;
  bot_events: string[];
}

export interface SlackManifest {
  display_information: { name: string; description: string };
  features: {
    app_home: {
      home_tab_enabled: boolean;
      messages_tab_enabled: boolean;
      messages_tab_read_only_enabled: boolean;
    };
    bot_user: { display_name: string; always_online: boolean };
  };
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
    features: {
      app_home: {
        home_tab_enabled: false,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      bot_user: { display_name: toDisplayName(appName), always_online: true },
    },
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
