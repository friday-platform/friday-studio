/**
 * Provider identifiers used by the playground UI.
 *
 * Mirrors `apps/link/src/providers/constants.ts` — kept as a parallel const
 * because the playground does not depend on `@atlas/link` (it talks to atlasd
 * via HTTP). The string value is the contract; both sides must agree.
 */

export const SLACK_APP_PROVIDER = "slack-app";
export const TELEGRAM_PROVIDER = "telegram";
export const DISCORD_PROVIDER = "discord";
export const TEAMS_PROVIDER = "teams";
export const WHATSAPP_PROVIDER = "whatsapp";
