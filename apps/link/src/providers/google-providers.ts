import { Buffer } from "node:buffer";
import { z } from "zod";
import { defineOAuthProvider, type OAuthProvider } from "./types.ts";

/**
 * Google OAuth via Gemini CLI Workspace Extension's verified client.
 *
 * The OAuth flow uses Google's verified `client_id` (owned by the Gemini
 * CLI Workspace Extension's GCP project) and routes the code-for-token
 * exchange through Google's hosted Cloud Function. The `client_secret`
 * never enters this binary — it lives in the Cloud Function's secret
 * store.
 *
 * Why this exists: Friday's prior client (`121686085713-...`) is not
 * verified, so it triggers Google's "unverified app" warning for any
 * external user. The Gemini extension's client IS verified for the same
 * scope set Friday needs, so by piggybacking on it the warning goes away.
 *
 * Posture caveat — the OAuth consent screen will display "Gemini CLI
 * Workspace Extension" instead of Friday Studio. Treat this as a tactical
 * shim until Friday has its own verified GCP project. Google can revoke
 * or rate-limit the public Cloud Function at any time, breaking this
 * flow without notice.
 */
const GEMINI_CLIENT_ID = "338689075775-o75k922vn5fdl18qergr96rp8g63e4d7.apps.googleusercontent.com";
const GEMINI_EXCHANGE_URI = "https://google-workspace-extension.geminicli.com";
const GEMINI_REFRESH_URI = `${GEMINI_EXCHANGE_URI}/refreshToken`;

/**
 * Encodes the OAuth `state` parameter in the format the Gemini Cloud
 * Function expects (per `cloud_function/index.js` and `AuthManager.ts:319-325`):
 *
 *   base64(JSON({ uri, manual: false, csrf }))
 *
 * The Cloud Function:
 *   1. Validates `payload.uri` resolves to localhost or 127.0.0.1.
 *   2. Performs the code-for-token exchange.
 *   3. Redirects to `payload.uri` with tokens appended as query params,
 *      and `?state=<csrf>` (the bare CSRF string — NOT the base64 payload).
 *
 * Friday's callback handler reads the bare `state` query param and
 * compares it against the expected CSRF (which is the JWT we minted).
 */
function encodeGeminiState({
  csrfToken,
  finalRedirectUri,
}: {
  csrfToken: string;
  finalRedirectUri: string;
}): string {
  return Buffer.from(
    JSON.stringify({ uri: finalRedirectUri, manual: false, csrf: csrfToken }),
  ).toString("base64");
}

/**
 * Google API scopes for each Workspace service.
 *
 * IMPORTANT: this set must remain a subset of what Gemini's published
 * GCP project verified. See `gemini-cli-extensions/workspace`'s
 * `feature-config.ts` — anything outside that set will re-introduce the
 * unverified-app warning, defeating the purpose of this swap.
 *
 * Notably absent: `spreadsheets` (sheets write), `presentations` (slides
 * write), and `tasks*`. These are flagged `defaultEnabled: false` in
 * upstream `feature-config.ts` with the comment "not in published GCP
 * project" — requesting them triggers Google's "This app is blocked"
 * page for any external user. Sheets is therefore read-only here.
 */
const GOOGLE_SCOPES = {
  calendar: ["https://www.googleapis.com/auth/calendar"],
  docs: [
    "https://www.googleapis.com/auth/documents",
    "https://www.googleapis.com/auth/drive.readonly",
  ],
  drive: ["https://www.googleapis.com/auth/drive"],
  gmail: ["https://www.googleapis.com/auth/gmail.modify"],
  sheets: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
} as const;

type GoogleService = keyof typeof GOOGLE_SCOPES;

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
      mode: "delegated",
      authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      delegatedExchangeUri: GEMINI_EXCHANGE_URI,
      delegatedRefreshUri: GEMINI_REFRESH_URI,
      clientId: GEMINI_CLIENT_ID,
      scopes: ["openid", "email", ...GOOGLE_SCOPES[service]],
      extraAuthParams: {
        access_type: "offline",
        // Mandatory: only way to guarantee Google returns a refresh_token
        // on the auth code exchange (per AuthManager.ts:335).
        prompt: "consent",
      },
      encodeState: encodeGeminiState,
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
