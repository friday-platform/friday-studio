/** Provider identifiers used as discriminators across credential, wiring, and summary code. */

/**
 * Slack App provider — joins to `credential.provider` and
 * `communicator_wiring.provider`. Deliberately distinct from the legacy
 * `"slack"` literal so wiring rows reference the bot installation, not the
 * user OAuth credential.
 */
export const SLACK_APP_PROVIDER = "slack-app";

/**
 * Telegram bot provider — apikey credential, mirrors the `kind: telegram`
 * communicator literal directly (no `-bot` suffix per the
 * communicator-wiring contract).
 */
export const TELEGRAM_PROVIDER = "telegram";
