import { z } from "zod";
import { defineOAuthProvider, type OAuthProvider } from "./types.ts";

// Google OAuth desktop app client ID (shipped with app, not sensitive).
// PKCE provides the real security; Google still requires client_secret present
// for Desktop app clients at the token endpoint.
const GCLOUD_CLIENT_ID = "121686085713-m7b2u1sari8j9l07ep3fodes3b85a1pm.apps.googleusercontent.com";
const GCLOUD_CLIENT_SECRET = "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";

/**
 * Google API scopes for each Workspace service.
 */
const GOOGLE_SCOPES = {
  calendar: ["https://www.googleapis.com/auth/calendar"],
  docs: [
    "https://www.googleapis.com/auth/documents",
    "https://www.googleapis.com/auth/drive.readonly",
  ],
  drive: ["https://www.googleapis.com/auth/drive"],
  gmail: ["https://www.googleapis.com/auth/gmail.modify"],
  sheets: [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive.readonly",
  ],
} as const;

type GoogleService = keyof typeof GOOGLE_SCOPES;

/**
 * Factory function for creating Google OAuth providers.
 * Uses shipped desktop app client ID with PKCE (no client_secret).
 *
 * Note: openid scope required - identify() uses userinfo endpoint
 * which needs openid to return subject ID for user identification.
 */
function createGoogleProvider(
  service: GoogleService,
  displayName: string,
  description: string,
): OAuthProvider {
  return defineOAuthProvider({
    id: `google-${service}`,
    displayName,
    description,
    oauthConfig: {
      mode: "static",
      authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenEndpoint: "https://oauth2.googleapis.com/token",
      userinfoEndpoint: "https://openidconnect.googleapis.com/v1/userinfo",
      clientId: GCLOUD_CLIENT_ID,
      clientSecret: GCLOUD_CLIENT_SECRET,
      clientAuthMethod: "client_secret_post",
      scopes: ["openid", "email", ...GOOGLE_SCOPES[service]],
      extraAuthParams: { access_type: "offline", prompt: "consent" },
    },
    identify: async (tokens) => {
      const res = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      const data = z.object({ sub: z.string(), email: z.string().email() }).parse(await res.json());
      return data.email;
    },
  });
}

/**
 * Creates Google Calendar OAuth provider.
 */
export function createGoogleCalendarProvider(): OAuthProvider {
  return createGoogleProvider("calendar", "Google Calendar", "Google Calendar access");
}

/**
 * Creates Google Docs OAuth provider.
 */
export function createGoogleDocsProvider(): OAuthProvider {
  return createGoogleProvider("docs", "Google Docs", "Google Docs document access");
}

/**
 * Creates Google Drive OAuth provider.
 */
export function createGoogleDriveProvider(): OAuthProvider {
  return createGoogleProvider("drive", "Google Drive", "Google Drive file access");
}

/**
 * Creates Gmail OAuth provider.
 */
export function createGoogleGmailProvider(): OAuthProvider {
  return createGoogleProvider("gmail", "Gmail", "Gmail email access");
}

/**
 * Creates Google Sheets OAuth provider.
 */
export function createGoogleSheetsProvider(): OAuthProvider {
  return createGoogleProvider("sheets", "Google Sheets", "Google Sheets spreadsheet access");
}
