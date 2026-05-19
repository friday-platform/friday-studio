import { z } from "zod";
import { defineOAuthProvider, type OAuthProvider } from "./types.ts";

/**
 * Friday Studio's Entra (Azure AD) app registration — multi-tenant public
 * client. No client_secret: token exchange uses PKCE.
 *
 * The consent screen will show "unverified publisher" until Microsoft
 * Publisher Verification lands; the client_id is stable across that
 * transition so already-connected users do not need to reconnect.
 */
const MICROSOFT_CLIENT_ID = "930b3b7e-69d9-40a2-942f-de96490061f5";

/** `common` lets work, school, and personal MSA accounts all sign in. */
const MICROSOFT_AUTH_BASE = "https://login.microsoftonline.com/common/oauth2/v2.0";

/**
 * Creates Microsoft Mail OAuth provider.
 *
 * Mail-only scopes — Calendar/Files/Teams will ship as separate providers
 * to keep consent screens minimal per-integration.
 */
export function createMicrosoftMailProvider(): OAuthProvider {
  return defineOAuthProvider({
    id: "microsoft-mail",
    displayName: "Microsoft Mail",
    description: "Read and send Outlook / Microsoft 365 mail",
    oauthConfig: {
      mode: "static",
      authorizationEndpoint: `${MICROSOFT_AUTH_BASE}/authorize`,
      tokenEndpoint: `${MICROSOFT_AUTH_BASE}/token`,
      clientId: MICROSOFT_CLIENT_ID,
      // Public client — PKCE only, no client_secret. Link's static mode
      // generates PKCE automatically and selects oauth.None() client auth
      // when clientSecret is unset.
      //
      // Request set is Graph resource scopes only — do NOT add `openid`,
      // `profile`, or `email` here. Microsoft's `/common` endpoint
      // rejects mixed Graph + OIDC scope requests on this multi-tenant
      // public client (`access_denied` from the consent screen).
      // Empirically, Microsoft still grants `openid profile email`
      // alongside `User.Read` in the resulting token's `scp` claim —
      // they're auto-augmented server-side. Identity comes from a Graph
      // `/me` call against the access token; no id_token is issued
      // because Link uses plain `response_type=code` without `nonce`.
      scopes: ["offline_access", "User.Read", "Mail.ReadWrite", "Mail.Send"],
      extraAuthParams: { prompt: "select_account" },
    },
    identify: async (tokens) => {
      // Returns `userPrincipalName` (email-shaped) over the immutable `id`
      // GUID intentionally: Link uses this same string as the connection's
      // display label, and a bare GUID is unreadable in the UI. Linear's
      // provider makes the same trade-off (`user.email ?? user.id`). The
      // cost is a duplicate credential row if an admin renames the UPN —
      // recoverable by reconnecting once. Switch to `id` if/when Link
      // splits userIdentifier from label.
      const res = await fetch("https://graph.microsoft.com/v1.0/me?$select=userPrincipalName", {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      if (!res.ok) {
        throw new Error(`Failed to fetch Microsoft user profile: ${res.status}`);
      }
      const data = z.object({ userPrincipalName: z.string().min(1) }).parse(await res.json());
      return data.userPrincipalName;
    },
  });
}
