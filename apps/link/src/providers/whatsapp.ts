import { randomBytes } from "node:crypto";
import { logger } from "@atlas/logger";
import { z } from "zod";
import { defineApiKeyProvider } from "./types.ts";

/**
 * WhatsApp Business (Meta Cloud API) apikey provider.
 *
 * The user pastes `access_token`, `app_secret`, and `phone_number_id` from
 * the Meta App Dashboard. `verify_token` is generated server-side at
 * credential creation time — Meta echoes it back in the GET verification
 * handshake when the admin saves the webhook URL in the dashboard, and Friday
 * compares the stored value against the echo to authenticate the handshake.
 *
 * **Caveat:** Meta's webhook subscription endpoints
 * (`POST /v{ver}/{app_id}/subscriptions` for app-level,
 * `POST /v{ver}/{waba_id}/subscribed_apps` for WABA-level) require either the
 * Meta App ID + an app access token, or the WhatsApp Business Account ID —
 * neither of which are part of this provider's secret schema (we only carry
 * `access_token` + `phone_number_id`). So `registerWebhook` is intentionally
 * a no-op that logs guidance: the admin pastes the callback URL +
 * verify_token into the Meta App Dashboard. Once Meta saves the URL, inbound
 * messages route normally via the stored `verify_token`.
 *
 * Track as a follow-up: extend the schema to carry `app_id` (or
 * `whatsapp_business_account_id`) so subscriptions can be set automatically.
 *
 * Field names mirror `WhatsAppProviderConfigSchema` in
 * `packages/config/src/signals.ts`.
 */
export const WhatsappSecretSchema = z.object({
  access_token: z.string().min(1),
  app_secret: z.string().min(1),
  phone_number_id: z.string().min(1),
});

export const whatsappProvider = defineApiKeyProvider({
  id: "whatsapp",
  displayName: "WhatsApp",
  description: "Connect a WhatsApp Business number via Meta Cloud API",
  docsUrl: "https://developers.facebook.com/docs/graph-api/webhooks/getting-started",
  secretSchema: WhatsappSecretSchema,
  autoFields: () => ({ verify_token: randomBytes(32).toString("hex") }),
  setupInstructions: `
1. In the [Meta App Dashboard](https://developers.facebook.com/apps/), open your WhatsApp Business app
2. Under **WhatsApp → API Setup**, copy the **Phone number ID** and a (preferably permanent System User) **access token**
3. Under **App Settings → Basic**, copy the **App secret**
4. Paste the three values below — Friday will generate a webhook \`verify_token\` for you
5. Back in the Meta dashboard, under **WhatsApp → Configuration**, paste your tunnel callback URL and the generated \`verify_token\` to subscribe the app

**Caveat:** Friday does not yet automate the webhook subscription call (it
requires fields not in this credential schema, e.g. the Meta App ID). You
must save the URL + verify_token in the Meta dashboard manually in step 5.
`,
  // deno-lint-ignore require-await
  registerWebhook: async ({ connectionId, callbackBaseUrl }) => {
    // TODO: extend secret schema with app_id (or whatsapp_business_account_id)
    // and call POST /v{ver}/{app_id}/subscriptions to subscribe automatically.
    // Until then, the admin saves the callback URL + verify_token in Meta's
    // dashboard manually (see setupInstructions).
    const callbackUrl = `${callbackBaseUrl}/platform/whatsapp/${connectionId}`;
    logger.warn("whatsapp_webhook_register_manual_required", {
      connectionId,
      callbackUrl,
      hint: "Paste callback URL + verify_token in Meta App Dashboard — Friday cannot subscribe automatically yet",
    });
  },
  // deno-lint-ignore require-await
  unregisterWebhook: async ({ connectionId }) => {
    logger.warn("whatsapp_webhook_unregister_manual_required", {
      connectionId,
      hint: "Remove the callback URL in Meta App Dashboard if needed",
    });
  },
});
