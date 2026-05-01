import { readFileSync } from "node:fs";
import { env } from "node:process";
import { stringifyError } from "@atlas/utils";
import { Client } from "@hubspot/api-client";
import { defineOAuthProvider, type OAuthProvider } from "./types.ts";

/**
 * Creates HubSpot account-level OAuth provider with read/write scopes.
 * Reads client credentials from files specified by env vars.
 *
 * @returns OAuthProvider if HUBSPOT_CLIENT_ID_FILE and HUBSPOT_CLIENT_SECRET_FILE are set, undefined otherwise
 */
export function createHubSpotProvider(): OAuthProvider | undefined {
  const clientIdFile = env.HUBSPOT_CLIENT_ID_FILE;
  const clientSecretFile = env.HUBSPOT_CLIENT_SECRET_FILE;

  if (!clientIdFile || !clientSecretFile) {
    return undefined;
  }

  const clientId = readFileSync(clientIdFile, "utf-8").trim();
  const clientSecret = readFileSync(clientSecretFile, "utf-8").trim();

  return defineOAuthProvider({
    id: "hubspot",
    displayName: "HubSpot",
    description: "HubSpot account-level access with read/write CRM permissions",
    oauthConfig: {
      mode: "static",
      authorizationEndpoint: "https://app.hubspot.com/oauth/authorize",
      tokenEndpoint: "https://api.hubapi.com/oauth/v1/token",
      clientId,
      clientSecret,
      scopes: [
        "oauth",
        "tickets",
        "crm.objects.contacts.read",
        "crm.objects.contacts.write",
        "crm.objects.companies.read",
        "crm.objects.companies.write",
        "crm.objects.deals.read",
        "crm.objects.deals.write",
        "crm.objects.line_items.read",
        "crm.objects.line_items.write",
        "crm.objects.owners.read",
      ],
      extraAuthParams: {
        optional_scope: [
          "crm.objects.orders.read",
          "crm.objects.orders.write",
          "crm.objects.quotes.read",
          "crm.objects.quotes.write",
          "crm.lists.read",
          "crm.lists.write",
          "crm.objects.users.read",
          "crm.objects.carts.read",
          "crm.objects.subscriptions.read",
          "crm.objects.invoices.read",
        ].join(" "),
      },
    },
    health: async (tokens) => {
      try {
        const client = new Client({ accessToken: tokens.access_token });
        await client.crm.contacts.basicApi.getPage(1);
        return { healthy: true };
      } catch (e) {
        return { healthy: false, error: stringifyError(e) };
      }
    },
    identify: async (tokens) => {
      const client = new Client({ accessToken: tokens.access_token });
      const info = await client.oauth.accessTokensApi.get(tokens.access_token);
      if (info.user) {
        return info.user;
      }
      if (info.userId == null) {
        throw new Error("HubSpot token info missing userId");
      }
      return String(info.userId);
    },
  });
}
