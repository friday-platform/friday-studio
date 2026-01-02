import process from "node:process";

/**
 * Sets up fake API credentials for eval testing.
 *
 * Validation code only checks if env vars exist, not if they're valid.
 * This allows eval tests to bypass validation and test workspace planning logic.
 *
 * Usage:
 * ```ts
 * await loadCredentials();  // Load real credentials first
 *
 * // Option 1: Set specific fake credentials
 * setupFakeCredentials(['SENDGRID_API_KEY', 'GITHUB_TOKEN']);
 *
 * // Option 2: Set all common fake credentials
 * setupFakeCredentials('all');
 * ```
 *
 * @param envVars - Array of env var names to fake, or 'all' for common integrations
 */
export function setupFakeCredentials(envVars: string[] | "all") {
  const varList =
    envVars === "all"
      ? [
          "SENDGRID_API_KEY",
          "TAVILY_API_KEY",
          "GITHUB_TOKEN",
          "GITHUB_PERSONAL_ACCESS_TOKEN",
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
          "NOTION_API_KEY",
          "TRELLO_API_KEY",
          "TRELLO_TOKEN",
        ]
      : envVars;

  const configured: string[] = [];

  for (const key of varList) {
    // Skip if already set
    if (process.env[key]) {
      continue;
    }

    // Generate random fake value
    const randomValue = generateFakeValue(key);
    process.env[key] = randomValue;
    configured.push(key);
  }

  if (configured.length > 0) {
    console.log(`[Eval Setup] Configured ${configured.length} fake credentials:`);
    for (const key of configured) {
      console.log(`  - ${key}`);
    }
  } else {
    console.log("[Eval Setup] All requested credentials already configured");
  }
}

/**
 * Generates a fake credential value with appropriate prefix/format for the env var name.
 */
function generateFakeValue(envVarName: string): string {
  const random = crypto.randomUUID().slice(0, 8);

  // Match common patterns
  if (envVarName.includes("SENDGRID")) {
    return `SG.fake_eval_${random}`;
  }
  if (envVarName.includes("GITHUB") && envVarName.includes("TOKEN")) {
    return `ghp_fake_eval_${random}`;
  }
  if (envVarName.includes("GITHUB") && envVarName.includes("PAT")) {
    return `ghp_fake_eval_${random}`;
  }
  if (envVarName.includes("TAVILY")) {
    return `tvly-fake_eval_${random}`;
  }
  if (envVarName.includes("STRIPE")) {
    return `sk_test_fake_eval_${random}`;
  }
  if (envVarName.includes("NOTION")) {
    return `secret_fake_eval_${random}`;
  }
  if (envVarName.includes("GOOGLE_") && envVarName.includes("_ACCESS_TOKEN")) {
    return `ya29.fake_eval_${random}`;
  }
  if (envVarName.includes("WEBHOOK_URL") || envVarName.includes("URL")) {
    return `https://fake-eval-webhook.example.com/${random}`;
  }
  if (envVarName.includes("EMAIL")) {
    return `fake-eval-${random}@example.com`;
  }
  if (envVarName.includes("SUBDOMAIN") || envVarName.includes("DOMAIN")) {
    return `fake-eval-${random}`;
  }

  // Default: generic fake token
  return `fake_eval_${random}_${envVarName.toLowerCase()}`;
}
