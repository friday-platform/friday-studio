import { logger } from "@atlas/logger";
import { z } from "zod";
import { defineApiKeyProvider } from "./types.ts";

/**
 * Microsoft Teams (Azure Bot Service) apikey provider.
 *
 * The user pastes `app_id`, `app_password`, `app_tenant_id`, and `app_type`
 * from the Azure Bot Service registration — all four are issued by Azure, so
 * there are no server-generated `autoFields`.
 *
 * **Caveat:** Teams' messaging endpoint lives on the Azure Bot Service ARM
 * resource and is updated via Azure Resource Manager
 * (`PATCH https://management.azure.com/subscriptions/.../botServices/{botName}`)
 * — which requires an Azure AD client-credential flow with a management-scope
 * access token. Implementing that auth flow here is non-trivial (token caching,
 * subscription/resource-group discovery, error mapping), so `registerWebhook`
 * is intentionally left as a no-op that logs a guidance event. The
 * `setupInstructions` direct the admin to set the messaging endpoint manually
 * in the Azure portal. `unregisterWebhook` is symmetric — also a no-op.
 *
 * Track this as a follow-up: implement client-credential ARM auth so the
 * messaging endpoint can be set automatically (parity with Discord/Telegram).
 *
 * Field names mirror `TeamsProviderConfigSchema` in
 * `packages/config/src/signals.ts`.
 */
export const TeamsSecretSchema = z.object({
  app_id: z.string().min(1),
  app_password: z.string().min(1),
  app_tenant_id: z.string().min(1),
  app_type: z.enum(["MultiTenant", "SingleTenant"]),
});

export const teamsProvider = defineApiKeyProvider({
  id: "teams",
  displayName: "Microsoft Teams",
  description: "Connect a Microsoft Teams bot via Azure Bot Service",
  docsUrl:
    "https://learn.microsoft.com/en-us/azure/bot-service/bot-service-resources-bot-framework-faq",
  secretSchema: TeamsSecretSchema,
  setupInstructions: `
1. In the [Azure portal](https://portal.azure.com/), open your Azure Bot resource
2. Under **Configuration**, set the **Messaging endpoint** to: \`<your-tunnel-url>/platform/teams/<app_id>\` (Friday cannot set this automatically — see caveat below)
3. Copy the **Microsoft App ID**, **App tenant ID**, and **App type** (MultiTenant or SingleTenant)
4. Under **Configuration → Manage Password**, create a client secret and copy its value (this is the **app_password**)
5. Paste the four values below

**Caveat:** Updating the messaging endpoint programmatically requires Azure ARM
client-credential auth, which Friday does not yet implement. You must set the
endpoint manually in step 2.
`,
  // deno-lint-ignore require-await
  registerWebhook: async ({ connectionId }) => {
    // TODO: implement Azure ARM client-credential auth + PATCH botServices to
    // set the messaging endpoint. Until then, admins set it manually in the
    // Azure portal (see setupInstructions). Surfaced as a logger event so
    // operators can grep for it during smoke tests.
    logger.warn("teams_webhook_register_manual_required", {
      connectionId,
      hint: "Set messaging endpoint in Azure portal — Friday cannot configure it automatically yet",
    });
  },
  // deno-lint-ignore require-await
  unregisterWebhook: async ({ connectionId }) => {
    logger.warn("teams_webhook_unregister_manual_required", {
      connectionId,
      hint: "Clear messaging endpoint in Azure portal if needed",
    });
  },
});
