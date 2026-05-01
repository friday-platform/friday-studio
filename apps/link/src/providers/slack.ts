import { logger } from "@atlas/logger";
import { z } from "zod";
import { defineApiKeyProvider } from "./types.ts";

/**
 * Slack bot apikey provider.
 *
 * The user pastes `bot_token`, `signing_secret`, and `app_id` from the Slack
 * app dashboard at api.slack.com/apps. All three are issued by Slack, so there
 * are no server-generated `autoFields`.
 *
 * Field names mirror `SlackProviderConfigSchema` in
 * `packages/config/src/signals.ts` so daemon-side resolvers can stay
 * symmetric.
 *
 * **Webhook registration:** Slack does not expose an API to set the Event
 * Subscriptions Request URL — it must be entered manually in the app
 * dashboard. `registerWebhook` therefore validates the bot token via
 * `auth.test` (failing fast if the token is bad) but does not register a URL
 * upstream. `unregisterWebhook` is a documented no-op; the operator removes
 * the URL by hand.
 *
 * **Inbound URL:** the daemon serves a single `/platform/slack` route and
 * dispatches to a workspace using `api_app_id` from the event body
 * (see `apps/atlasd/routes/signals/platform.ts`). The instructions therefore
 * point users at `<callbackBaseUrl>/platform/slack` with no `:app_id`
 * segment — the routing key lives in the payload, not the path.
 */
export const SlackSecretSchema = z.object({
  bot_token: z.string().min(1),
  signing_secret: z.string().min(1),
  app_id: z.string().min(1),
});

/** Subset of Slack `auth.test` response we consume. */
const SlackAuthTestResponseSchema = z.object({
  ok: z.boolean(),
  team_id: z.string().optional(),
  team: z.string().optional(),
  user_id: z.string().optional(),
  error: z.string().optional(),
});

export const slackProvider = defineApiKeyProvider({
  id: "slack",
  displayName: "Slack",
  description: "Connect a Slack bot to receive events and post replies",
  docsUrl: "https://api.slack.com/apps",
  secretSchema: SlackSecretSchema,
  setupInstructions: `
1. Open the [Slack API app dashboard](https://api.slack.com/apps) and create a new app (From scratch)
2. Under **Basic Information** → **App Credentials**, copy the **App ID** (starts with \`A0\`) and **Signing Secret**
3. Under **OAuth & Permissions** → **Scopes** → **Bot Token Scopes**, add: \`app_mentions:read\`, \`chat:write\`, \`channels:history\`, \`channels:read\`, \`groups:history\`, \`groups:read\`, \`im:history\`, \`im:read\`, \`mpim:history\`, \`mpim:read\`, \`users:read\`
4. Click **Install to Workspace**, then copy the **Bot User OAuth Token** (\`xoxb-...\`)
5. Paste \`bot_token\`, \`signing_secret\`, and \`app_id\` below
6. After saving, return to the Slack app dashboard → **Event Subscriptions**, enable events, and paste \`<callbackBaseUrl>/platform/slack\` into **Request URL**. Slack will send a verification challenge to that URL; once it succeeds, subscribe to bot events such as \`app_mention\` and \`message.im\`.
`,
  registerWebhook: async ({ secret, connectionId }) => {
    const parsed = SlackSecretSchema.parse(secret);
    const res = await fetch("https://slack.com/api/auth.test", {
      method: "POST",
      headers: { Authorization: `Bearer ${parsed.bot_token}` },
    });
    const body: unknown = await res.json().catch(() => ({}));
    const parsedBody = SlackAuthTestResponseSchema.safeParse(body);
    if (!res.ok || !parsedBody.success || !parsedBody.data.ok) {
      const desc = parsedBody.success
        ? (parsedBody.data.error ?? `HTTP ${res.status}`)
        : `HTTP ${res.status}`;
      throw new Error(`Slack auth.test failed: ${desc}`);
    }
    logger.info("slack_credentials_validated", { connectionId, team_id: parsedBody.data.team_id });
  },
  // deno-lint-ignore require-await
  unregisterWebhook: async ({ connectionId }) => {
    logger.info("slack_webhook_unregister_noop", {
      connectionId,
      reason:
        "Slack does not expose an API to remove the Event Subscriptions URL. Remove it manually from the Slack app dashboard if desired.",
    });
  },
});
