/** Provider identifiers used as discriminators across credential, wiring, and summary code. */

/**
 * Slack bot apikey provider — mirrors the `kind: slack` communicator literal.
 * Users paste `bot_token`, `signing_secret`, and `app_id` from
 * api.slack.com/apps directly.
 */
export const SLACK_PROVIDER = "slack";

/**
 * Telegram bot provider — apikey credential, mirrors the `kind: telegram`
 * communicator literal directly (no `-bot` suffix per the
 * communicator-wiring contract).
 */
export const TELEGRAM_PROVIDER = "telegram";

/** Discord bot provider — apikey credential, mirrors the `kind: discord` literal. */
export const DISCORD_PROVIDER = "discord";

/** Microsoft Teams bot provider — apikey credential, mirrors the `kind: teams` literal. */
export const TEAMS_PROVIDER = "teams";

/** WhatsApp Business provider — apikey credential, mirrors the `kind: whatsapp` literal. */
export const WHATSAPP_PROVIDER = "whatsapp";
