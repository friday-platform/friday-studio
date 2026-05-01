import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
// Import all provider factories from consolidated module
import {
  createGoogleCalendarProvider,
  createGoogleDocsProvider,
  createGoogleDriveProvider,
  createGoogleGmailProvider,
  createGoogleSheetsProvider,
} from "./google-providers.ts";

// Provider factories with expected metadata
const PROVIDERS = [
  { factory: createGoogleCalendarProvider, id: "google-calendar", scope: "calendar" },
  { factory: createGoogleGmailProvider, id: "google-gmail", scope: "gmail.modify" },
  { factory: createGoogleDriveProvider, id: "google-drive", scope: "drive" },
  { factory: createGoogleDocsProvider, id: "google-docs", scope: "documents" },
  { factory: createGoogleSheetsProvider, id: "google-sheets", scope: "spreadsheets" },
] as const;

describe("Google providers", () => {
  it("return configured OAuth providers with correct metadata", () => {
    for (const { factory, id, scope } of PROVIDERS) {
      const provider = factory();
      expect(provider, `${id} should be defined`).toBeDefined();
      expect(provider.type, `${id} should be oauth type`).toBe("oauth");
      expect(provider.id, `${id} id mismatch`).toBe(id);
      if (provider.oauthConfig.mode !== "delegated") {
        throw new Error(`${id} should be delegated mode, got ${provider.oauthConfig.mode}`);
      }
      const oauthConfig = provider.oauthConfig;

      // Delegated mode: client_secret lives in the Cloud Function, not here.
      expect(oauthConfig.clientId, `${id} should have clientId`).toBeDefined();
      expect(oauthConfig.delegatedExchangeUri, `${id} should have delegatedExchangeUri`).toMatch(
        /geminicli\.com/,
      );
      expect(oauthConfig.delegatedRefreshUri, `${id} should have delegatedRefreshUri`).toMatch(
        /\/refreshToken$/,
      );
      expect(typeof oauthConfig.encodeState, `${id} should expose encodeState`).toBe("function");

      // Scopes should include openid, email, and the service scope
      const scopes = oauthConfig.scopes ?? [];
      expect(scopes, `${id} should include openid`).toContain("openid");
      expect(scopes, `${id} should include email`).toContain("email");
      expect(
        scopes.some((s) => s.includes(scope)),
        `${id} should include ${scope} scope`,
      ).toBe(true);
    }
  });

  it("encodeState produces base64-encoded {uri, manual, csrf} payload", () => {
    const provider = createGoogleGmailProvider();
    if (provider.oauthConfig.mode !== "delegated") throw new Error("expected delegated mode");

    const encoded = provider.oauthConfig.encodeState({
      csrfToken: "csrf-abc",
      finalRedirectUri: "http://localhost:3100/v1/callback/google-gmail",
    });

    const decoded = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    expect(decoded).toEqual({
      uri: "http://localhost:3100/v1/callback/google-gmail",
      manual: false,
      csrf: "csrf-abc",
    });
  });
});
