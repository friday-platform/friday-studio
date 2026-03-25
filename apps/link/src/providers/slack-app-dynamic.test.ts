import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TestStorageAdapter, TestWebhookSecretRepository } from "../adapters/test-storage.ts";
import { encodeAppInstallState } from "../app-install/app-state.ts";
import { PENDING_TOKEN } from "../slack-apps/manifest.ts";
import { createSlackAppDynamicProvider } from "./slack-app-dynamic.ts";

describe("slack-app dynamic provider", () => {
  let storage: TestStorageAdapter;
  let provider: ReturnType<typeof createSlackAppDynamicProvider>;
  const userId = "user-1";
  let credentialId: string;

  const slackOAuthSuccess = {
    ok: true,
    access_token: "xoxb-bot-token-123",
    token_type: "bot",
    scope: "chat:write,channels:read",
    bot_user_id: "B012ABCDE",
    app_id: "A012ABCD0A0",
    team: { id: "T024BE7LD", name: "Test Workspace" },
    authed_user: { id: "U01234" },
  };

  beforeEach(async () => {
    storage = new TestStorageAdapter();
    provider = createSlackAppDynamicProvider(storage, new TestWebhookSecretRepository());

    // Seed an incomplete slack-app credential
    const { id } = await storage.save(
      {
        type: "oauth",
        provider: "slack-app",
        label: "ws-123",
        secret: {
          platform: "slack",
          externalId: "A012ABCD0A0",
          access_token: PENDING_TOKEN,
          slack: {
            clientId: "1234567890.1234567890",
            clientSecret: "secret-abc",
            slackUserCredentialId: "cred-user-1",
          },
        },
      },
      userId,
    );
    credentialId = id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe("completeInstallation", () => {
    it("exchanges code for bot token and returns updated credential", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(slackOAuthSuccess))),
      );

      const params = new URLSearchParams();
      params.set("credential_id", credentialId);
      params.set("user_id", userId);

      const result = await provider.completeInstallation(
        "auth-code-123",
        "https://link.example.com/v1/callback/slack-app",
        params,
      );

      expect(result.externalId).toBe("A012ABCD0A0");
      expect(result.externalName).toBe("Test Workspace");
      expect(result.credential).toMatchObject({
        type: "oauth",
        provider: "slack-app",
        label: "Test Workspace",
        secret: {
          platform: "slack",
          externalId: "A012ABCD0A0",
          access_token: "xoxb-bot-token-123",
          slack: {
            clientId: "1234567890.1234567890",
            clientSecret: "secret-abc",
            slackUserCredentialId: "cred-user-1",
          },
        },
      });

      const fetchCall = vi.mocked(fetch).mock.calls[0];
      expect(fetchCall).toBeDefined();
      expect(fetchCall?.[0]).toBe("https://slack.com/api/oauth.v2.access");
      const opts = fetchCall?.[1];
      expect(opts?.headers).toMatchObject({
        Authorization: `Basic ${btoa("1234567890.1234567890:secret-abc")}`,
      });
    });

    it("throws MISSING_CODE when no code provided", async () => {
      const params = new URLSearchParams();
      params.set("credential_id", credentialId);
      params.set("user_id", userId);

      await expect(
        provider.completeInstallation(undefined, "https://example.com/cb", params),
      ).rejects.toMatchObject({ code: "MISSING_CODE" });
    });

    it("throws INVALID_CREDENTIAL when credential_id missing from params", async () => {
      const params = new URLSearchParams();
      params.set("user_id", userId);

      await expect(
        provider.completeInstallation("code", "https://example.com/cb", params),
      ).rejects.toMatchObject({ code: "INVALID_CREDENTIAL" });
    });

    it("throws INVALID_CREDENTIAL when user_id missing from params", async () => {
      const params = new URLSearchParams();
      params.set("credential_id", credentialId);

      await expect(
        provider.completeInstallation("code", "https://example.com/cb", params),
      ).rejects.toMatchObject({ code: "INVALID_CREDENTIAL" });
    });

    it("throws SLACK_HTTP_ERROR on non-2xx response from Slack", async () => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response("Internal Server Error", { status: 500 })),
      );

      const params = new URLSearchParams();
      params.set("credential_id", credentialId);
      params.set("user_id", userId);

      await expect(
        provider.completeInstallation("code", "https://example.com/cb", params),
      ).rejects.toMatchObject({
        code: "SLACK_HTTP_ERROR",
        message: expect.stringContaining("500"),
      });
    });

    it("throws CREDENTIAL_NOT_FOUND for non-existent credential", async () => {
      const params = new URLSearchParams();
      params.set("credential_id", "nonexistent");
      params.set("user_id", userId);

      await expect(
        provider.completeInstallation("code", "https://example.com/cb", params),
      ).rejects.toMatchObject({ code: "CREDENTIAL_NOT_FOUND" });
    });

    it("throws SLACK_OAUTH_ERROR when Slack returns ok: false", async () => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(new Response(JSON.stringify({ ok: false, error: "invalid_code" }))),
      );

      const params = new URLSearchParams();
      params.set("credential_id", credentialId);
      params.set("user_id", userId);

      await expect(
        provider.completeInstallation("bad-code", "https://example.com/cb", params),
      ).rejects.toMatchObject({
        code: "SLACK_OAUTH_ERROR",
        message: expect.stringContaining("invalid_code"),
      });
    });
  });

  describe("buildAuthorizationUrl", () => {
    it("reuses existing incomplete credential (idempotency)", async () => {
      const state = await encodeAppInstallState({ p: "slack-app", u: userId });

      const url = await provider.buildAuthorizationUrl("https://example.com/cb", state);
      const parsed = new URL(url);

      expect(parsed.origin + parsed.pathname).toBe("https://slack.com/oauth/v2/authorize");
      expect(parsed.searchParams.get("client_id")).toBe("1234567890.1234567890");
      expect(parsed.searchParams.get("redirect_uri")).toBe("https://example.com/cb");
      expect(parsed.searchParams.has("state")).toBe(true);
    });

    it("creates app via manifest API when no incomplete credential exists", async () => {
      // Remove the seeded incomplete credential so the creation path is exercised
      await storage.delete(credentialId, userId);

      // Seed a slack-user credential
      await storage.save(
        {
          type: "oauth",
          provider: "slack-user",
          label: "Team",
          secret: { access_token: "xoxp-user-token" },
        },
        userId,
      );

      const state = await encodeAppInstallState({ p: "slack-app", u: userId });

      const manifestCreateResp = {
        ok: true,
        app_id: "A_NEW_APP",
        credentials: {
          client_id: "new-client-id",
          client_secret: "new-client-secret",
          signing_secret: "new-signing-secret",
          verification_token: "vt",
        },
        oauth_authorize_url: "https://slack.com/oauth/v2/authorize",
      };

      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(manifestCreateResp))),
      );

      const url = await provider.buildAuthorizationUrl("https://example.com/cb", state);
      const parsed = new URL(url);

      expect(parsed.origin + parsed.pathname).toBe("https://slack.com/oauth/v2/authorize");
      expect(parsed.searchParams.get("client_id")).toBe("new-client-id");
      expect(parsed.searchParams.get("redirect_uri")).toBe("https://example.com/cb");
      expect(parsed.searchParams.has("state")).toBe(true);

      // Verify incomplete credential was saved with placeholder label
      const creds = await storage.list("oauth", userId);
      const slackApp = creds.find((c) => c.provider === "slack-app" && c.label === "Slack Bot");
      expect(slackApp).toBeDefined();
    });

    it("throws CREDENTIAL_NOT_FOUND when no slack-user credential exists", async () => {
      // Remove seeded slack-app cred so findIncompleteCredential won't match
      await storage.delete(credentialId, userId);

      const state = await encodeAppInstallState({ p: "slack-app", u: "user-no-slack" });

      await expect(
        provider.buildAuthorizationUrl("https://example.com/cb", state),
      ).rejects.toMatchObject({ code: "CREDENTIAL_NOT_FOUND" });
    });
  });
});
