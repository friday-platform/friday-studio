/** Strip the internal "(APP_ID)" suffix from slack-app credential labels for display. */
export function stripSlackAppId(label: string): string {
  return label.replace(/\s*\([A-Z0-9]+\)$/, "");
}

/** Slack bot display_name max length (mirrors `DISPLAY_NAME_MAX` in link's manifest.ts). */
const DISPLAY_NAME_MAX = 80;

/**
 * Sanitizes a workspace name into a Slack bot display_name.
 * Mirrors `toDisplayName` in `apps/link/src/slack-apps/manifest.ts` — kept
 * in sync so the web-client can render the @mention string without a round
 * trip to Slack. Strips characters outside letters/digits/space/-/_/. and
 * collapses runs of spaces.
 */
export function toSlackBotDisplayName(name: string): string {
  const sanitized = name
    .trim()
    .replace(/[^a-zA-Z0-9 \-_.]/g, "")
    .replace(/ {2,}/g, " ")
    .trim()
    .slice(0, DISPLAY_NAME_MAX);
  return sanitized || "friday";
}
