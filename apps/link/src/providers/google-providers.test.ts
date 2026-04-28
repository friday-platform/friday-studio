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
      if (provider.oauthConfig.mode !== "static") {
        throw new Error(`${id} should be static mode, got ${provider.oauthConfig.mode}`);
      }
      const oauthConfig = provider.oauthConfig;

      // Desktop app client — PKCE provides real security but Google still requires
      // client_secret present for Desktop app clients at the token endpoint.
      expect(oauthConfig.clientAuthMethod, `${id} should use client_secret_post`).toBe(
        "client_secret_post",
      );
      expect(oauthConfig.clientSecret, `${id} should have client_secret`).toBeDefined();

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
});
