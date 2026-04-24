import { z } from "zod";
import { defineOAuthProvider, type OAuthProvider } from "./types.ts";

// Well-known gcloud OAuth client credentials (public, not sensitive).
const GCLOUD_CLIENT_ID = "764086051850-6qr4p6gpi6hn506pt8ejuq83di341hur.apps.googleusercontent.com";
const GCLOUD_CLIENT_SECRET = "d-FL95Q19q7MQmFpd7hHD0Ty";

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
 * Uses well-known gcloud client credentials (public, not sensitive).
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
