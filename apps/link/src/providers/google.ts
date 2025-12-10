import { readFileSync } from "node:fs";
import { env } from "node:process";
import { defineOAuthProvider, type OAuthProvider } from "./types.ts";

export function createGoogleProvider(): OAuthProvider | undefined {
  const clientIdFile = env.GOOGLE_CLIENT_ID_FILE;
  const clientSecretFile = env.GOOGLE_CLIENT_SECRET_FILE;

  if (!clientIdFile || !clientSecretFile) {
    return undefined; // Let registry handle skip logging
  }

  const clientId = readFileSync(clientIdFile, "utf-8").trim();
  const clientSecret = readFileSync(clientSecretFile, "utf-8").trim();

  return defineOAuthProvider({
    id: "google",
    displayName: "Google",
    description: "Google Account access",
    oauthConfig: {
      mode: "static",
      authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenEndpoint: "https://oauth2.googleapis.com/token",
      userinfoEndpoint: "https://openidconnect.googleapis.com/v1/userinfo",
      clientId,
      clientSecret,
      clientAuthMethod: "client_secret_post",
      scopes: ["openid", "email", "profile"],
      extraAuthParams: { access_type: "offline", prompt: "consent" },
    },
    identify: async (tokens) => {
      const res = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      const data = (await res.json()) as { sub: string };
      return data.sub; // immutable, unlike email which can change
    },
  });
}
