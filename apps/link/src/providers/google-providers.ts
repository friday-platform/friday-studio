import { readFileSync } from "node:fs";
import { env } from "node:process";
import { z } from "zod";
import { defineOAuthProvider, type OAuthProvider } from "./types.ts";

/**
 * Google API scopes for each Workspace service.
 */
const GOOGLE_SCOPES = {
  calendar: "https://www.googleapis.com/auth/calendar",
  docs: "https://www.googleapis.com/auth/documents",
  drive: "https://www.googleapis.com/auth/drive",
  gmail: "https://www.googleapis.com/auth/gmail.modify",
  sheets: "https://www.googleapis.com/auth/spreadsheets",
} as const;

type GoogleService = keyof typeof GOOGLE_SCOPES;

/**
 * Factory function for creating Google OAuth providers.
 * Reads client credentials from files specified by env vars.
 *
 * Note: openid scope required - identify() uses userinfo endpoint
 * which needs openid to return subject ID for user identification.
 *
 * @returns OAuthProvider if env configured, undefined otherwise
 */
function createGoogleProvider(
  service: GoogleService,
  displayName: string,
  description: string,
): OAuthProvider | undefined {
  const clientIdFile = env.GOOGLE_CLIENT_ID_FILE;
  const clientSecretFile = env.GOOGLE_CLIENT_SECRET_FILE;

  if (!clientIdFile || !clientSecretFile) {
    return undefined;
  }

  const clientId = readFileSync(clientIdFile, "utf-8").trim();
  const clientSecret = readFileSync(clientSecretFile, "utf-8").trim();

  return defineOAuthProvider({
    id: `google-${service}`,
    displayName,
    description,
    oauthConfig: {
      mode: "static",
      authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenEndpoint: "https://oauth2.googleapis.com/token",
      userinfoEndpoint: "https://openidconnect.googleapis.com/v1/userinfo",
      clientId,
      clientSecret,
      clientAuthMethod: "client_secret_post",
      scopes: ["openid", "email", GOOGLE_SCOPES[service]],
      extraAuthParams: { access_type: "offline", prompt: "consent" },
    },
    identify: async (tokens) => {
      const res = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      const data = z.object({ sub: z.string() }).parse(await res.json());
      return data.sub;
    },
  });
}

/**
 * Creates Google Calendar OAuth provider.
 */
export function createGoogleCalendarProvider(): OAuthProvider | undefined {
  return createGoogleProvider("calendar", "Google Calendar", "Google Calendar access");
}

/**
 * Creates Google Docs OAuth provider.
 */
export function createGoogleDocsProvider(): OAuthProvider | undefined {
  return createGoogleProvider("docs", "Google Docs", "Google Docs document access");
}

/**
 * Creates Google Drive OAuth provider.
 */
export function createGoogleDriveProvider(): OAuthProvider | undefined {
  return createGoogleProvider("drive", "Google Drive", "Google Drive file access");
}

/**
 * Creates Gmail OAuth provider.
 */
export function createGoogleGmailProvider(): OAuthProvider | undefined {
  return createGoogleProvider("gmail", "Gmail", "Gmail email access");
}

/**
 * Creates Google Sheets OAuth provider.
 */
export function createGoogleSheetsProvider(): OAuthProvider | undefined {
  return createGoogleProvider("sheets", "Google Sheets", "Google Sheets spreadsheet access");
}
