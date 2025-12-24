import { stringifyError } from "@atlas/utils";
import { z } from "zod";
import { defineApiKeyProvider } from "./types.ts";

export const SlackSecretSchema = z.object({
  access_token: z
    .string()
    .regex(
      /^xox[bp]-/,
      "Invalid Slack token format. Must be a bot token (xoxb-) or user token (xoxp-)",
    ),
});

/**
 * Schema for Slack's auth.test API response.
 * @see https://api.slack.com/methods/auth.test
 */
const SlackAuthTestResponseSchema = z.object({
  ok: z.boolean(),
  url: z.string().optional(),
  team: z.string().optional(),
  user: z.string().optional(),
  team_id: z.string().optional(),
  user_id: z.string().optional(),
  bot_id: z.string().optional(),
  error: z.string().optional(),
});

export const slackProvider = defineApiKeyProvider({
  id: "slack",
  displayName: "Slack",
  description: "Team messaging and collaboration platform",
  docsUrl: "https://api.slack.com/docs",
  secretSchema: SlackSecretSchema,
  setupInstructions: `
# Slack Bot Token Setup

## 1. Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Click **Create New App** → **From scratch**
3. Name your app and select your workspace

## 2. Configure Bot Scopes

Navigate to **OAuth & Permissions** and add these Bot Token Scopes:

- \`channels:history\` - View messages in public channels
- \`channels:read\` - View public channel info
- \`chat:write\` - Send messages
- \`groups:history\` - View messages in private channels
- \`groups:read\` - View private channel info
- \`im:history\` - View direct messages
- \`im:read\` - View DM info
- \`im:write\` - Send DMs
- \`users:read\` - View user info

## 3. Install to Workspace

1. Click **Install to Workspace**
2. Authorize the permissions
3. Copy the **Bot User OAuth Token** (starts with \`xoxb-\`)

## 4. Add Bot to Channels

For each channel the bot should access:
1. Open the channel
2. Click channel name → **Integrations** → **Add an App**
3. Select your app
`,
  health: async (secret) => {
    try {
      const response = await fetch("https://slack.com/api/auth.test", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret.access_token}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      });

      const data = SlackAuthTestResponseSchema.parse(await response.json());

      if (!data.ok) {
        return { healthy: false, error: data.error ?? "Unknown Slack auth error" };
      }

      return {
        healthy: true,
        metadata: {
          teamName: data.team,
          teamId: data.team_id,
          userId: data.user_id,
          botId: data.bot_id,
        },
      };
    } catch (e) {
      return { healthy: false, error: stringifyError(e) };
    }
  },
});
