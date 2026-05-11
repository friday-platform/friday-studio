import { Buffer } from "node:buffer";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// Import all provider factories from consolidated module
import {
  createGoogleCalendarProvider,
  createGoogleDocsProvider,
  createGoogleDriveProvider,
  createGoogleGmailProvider,
  createGoogleSheetsProvider,
} from "./google-providers.ts";
import { notionProvider } from "./notion.ts";

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

  it('tags every Google provider with family: "google" for elicitation dedup', () => {
    for (const { factory, id } of PROVIDERS) {
      const provider = factory();
      expect(provider.family, `${id} should have family: "google"`).toBe("google");
    }
  });

  it("leaves family undefined on non-Google OAuth providers", () => {
    // Sanity check: only providers that opt in carry a family; default callers
    // fall back to provider.id (no central change needed).
    expect(notionProvider.family).toBeUndefined();
  });

  describe("delegated URI env-var overrides", () => {
    const ORIGINAL_EXCHANGE = process.env.FRIDAY_OAUTH_MOCK_EXCHANGE_URI;
    const ORIGINAL_REFRESH = process.env.FRIDAY_OAUTH_MOCK_REFRESH_URI;

    beforeEach(() => {
      delete process.env.FRIDAY_OAUTH_MOCK_EXCHANGE_URI;
      delete process.env.FRIDAY_OAUTH_MOCK_REFRESH_URI;
    });

    afterEach(() => {
      if (ORIGINAL_EXCHANGE === undefined) {
        delete process.env.FRIDAY_OAUTH_MOCK_EXCHANGE_URI;
      } else {
        process.env.FRIDAY_OAUTH_MOCK_EXCHANGE_URI = ORIGINAL_EXCHANGE;
      }
      if (ORIGINAL_REFRESH === undefined) {
        delete process.env.FRIDAY_OAUTH_MOCK_REFRESH_URI;
      } else {
        process.env.FRIDAY_OAUTH_MOCK_REFRESH_URI = ORIGINAL_REFRESH;
      }
    });

    it("uses production URIs when neither override env var is set", () => {
      const provider = createGoogleCalendarProvider();
      if (provider.oauthConfig.mode !== "delegated") throw new Error("expected delegated mode");
      expect(provider.oauthConfig.delegatedExchangeUri).toBe(
        "https://google-workspace-extension.geminicli.com",
      );
      expect(provider.oauthConfig.delegatedRefreshUri).toBe(
        "https://google-workspace-extension.geminicli.com/refreshToken",
      );
    });

    it("uses override URIs when both env vars are set", () => {
      process.env.FRIDAY_OAUTH_MOCK_EXCHANGE_URI = "http://127.0.0.1:8081";
      process.env.FRIDAY_OAUTH_MOCK_REFRESH_URI = "http://127.0.0.1:8081/refreshToken";

      const provider = createGoogleGmailProvider();
      if (provider.oauthConfig.mode !== "delegated") throw new Error("expected delegated mode");
      expect(provider.oauthConfig.delegatedExchangeUri).toBe("http://127.0.0.1:8081");
      expect(provider.oauthConfig.delegatedRefreshUri).toBe("http://127.0.0.1:8081/refreshToken");
    });

    it("falls back to production URIs when only the exchange override is set", () => {
      process.env.FRIDAY_OAUTH_MOCK_EXCHANGE_URI = "http://127.0.0.1:8081";

      const provider = createGoogleDriveProvider();
      if (provider.oauthConfig.mode !== "delegated") throw new Error("expected delegated mode");
      expect(provider.oauthConfig.delegatedExchangeUri).toMatch(/geminicli\.com$/);
      expect(provider.oauthConfig.delegatedRefreshUri).toMatch(/geminicli\.com\/refreshToken$/);
    });

    it("falls back to production URIs when only the refresh override is set", () => {
      process.env.FRIDAY_OAUTH_MOCK_REFRESH_URI = "http://127.0.0.1:8081/refreshToken";

      const provider = createGoogleDriveProvider();
      if (provider.oauthConfig.mode !== "delegated") throw new Error("expected delegated mode");
      expect(provider.oauthConfig.delegatedExchangeUri).toMatch(/geminicli\.com$/);
      expect(provider.oauthConfig.delegatedRefreshUri).toMatch(/geminicli\.com\/refreshToken$/);
    });

    it("resolves env vars at registration time, not module load", () => {
      // Confirms that setting the env vars after import still takes effect on
      // the next factory call — the property the test launcher relies on.
      const before = createGoogleCalendarProvider();
      if (before.oauthConfig.mode !== "delegated") throw new Error("expected delegated mode");
      expect(before.oauthConfig.delegatedRefreshUri).toMatch(/geminicli\.com\/refreshToken$/);

      process.env.FRIDAY_OAUTH_MOCK_EXCHANGE_URI = "http://127.0.0.1:9999";
      process.env.FRIDAY_OAUTH_MOCK_REFRESH_URI = "http://127.0.0.1:9999/refreshToken";

      const after = createGoogleCalendarProvider();
      if (after.oauthConfig.mode !== "delegated") throw new Error("expected delegated mode");
      expect(after.oauthConfig.delegatedRefreshUri).toBe("http://127.0.0.1:9999/refreshToken");
    });
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
