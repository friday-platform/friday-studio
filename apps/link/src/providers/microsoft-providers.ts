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
      // No `openid` / `profile` / `email`: identity comes from a Graph
      // `/me` call against the access token (User.Read covers it). With
      // openid, Microsoft's `/common` endpoint returns an id_token whose
      // `iss` claim is tenant-scoped (`.../{tid}/v2.0`), which
      // oauth4webapi can't match against a static `as.issuer`. Dropping
      // openid skips id_token issuance and the validation step.
      scopes: ["offline_access", "User.Read", "Mail.ReadWrite", "Mail.Send"],
      extraAuthParams: { prompt: "select_account" },
    },
    identify: async (tokens) => {
      const res = await fetch("https://graph.microsoft.com/v1.0/me", {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      if (!res.ok) {
        throw new Error(`Failed to fetch Microsoft user profile: ${res.status}`);
      }
      const data = z.object({ userPrincipalName: z.string() }).parse(await res.json());
      return data.userPrincipalName;
    },
  });
}
