/**
 * Sets up fake API credentials for eval testing.
 *
 * Validation code only checks if env vars exist, not if they're valid.
 * This allows eval tests to bypass credential validation and test
 * pipeline logic that branches on credential presence.
 *
 * @param envVars - Array of env var names to fake, or 'all' for common integrations
 */

import process from "node:process";

const ALL_FAKE_CREDENTIALS = [
  "SENDGRID_API_KEY",
  "TAVILY_API_KEY",
  "GH_TOKEN",
  "GOOGLE_CALENDAR_ACCESS_TOKEN",
  "GOOGLE_GMAIL_ACCESS_TOKEN",
  "GOOGLE_DRIVE_ACCESS_TOKEN",
  "GOOGLE_DOCS_ACCESS_TOKEN",
  "GOOGLE_SHEETS_ACCESS_TOKEN",
  "ACCUWEATHER_API_KEY",
  "DISCORD_TOKEN",
  "DISCORD_BOT_TOKEN",
  "DISCORD_WEBHOOK_URL",
  "ZENDESK_API_TOKEN",
  "ZENDESK_EMAIL",
  "ZENDESK_SUBDOMAIN",
  "STRIPE_SECRET_KEY",
  "SLACK_MCP_XOXP_TOKEN",
  "NOTION_API_KEY",
  "TRELLO_API_KEY",
  "TRELLO_TOKEN",
] as const;

export function setupFakeCredentials(envVars: string[] | "all"): void {
  const varList = envVars === "all" ? [...ALL_FAKE_CREDENTIALS] : envVars;

  for (const key of varList) {
    if (process.env[key]) continue;
    process.env[key] = generateFakeValue(key);
  }
}

/** Generates a fake credential value with appropriate prefix/format. */
function generateFakeValue(envVarName: string): string {
  const random = crypto.randomUUID().slice(0, 8);

  if (envVarName.includes("SENDGRID")) return `SG.fake_eval_${random}`;
  if (envVarName.includes("GITHUB") && envVarName.includes("TOKEN"))
    return `ghp_fake_eval_${random}`;
  if (envVarName.includes("TAVILY")) return `tvly-fake_eval_${random}`;
  if (envVarName.includes("STRIPE")) return `sk_test_fake_eval_${random}`;
  if (envVarName.includes("NOTION")) return `secret_fake_eval_${random}`;
  if (envVarName.includes("GOOGLE_") && envVarName.includes("_ACCESS_TOKEN"))
    return `ya29.fake_eval_${random}`;
  if (envVarName.includes("WEBHOOK_URL") || envVarName.includes("URL"))
    return `https://fake-eval-webhook.example.com/${random}`;
  if (envVarName.includes("EMAIL")) return `fake-eval-${random}@example.com`;
  if (envVarName.includes("SUBDOMAIN") || envVarName.includes("DOMAIN"))
    return `fake-eval-${random}`;

  return `fake_eval_${random}_${envVarName.toLowerCase()}`;
}
