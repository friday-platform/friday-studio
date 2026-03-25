import { afterEach, describe, expect, it, vi } from "vitest";
import { createSlackUserProvider } from "./slack-user.ts";

describe("createSlackUserProvider", () => {
  it("returns undefined when env vars are missing", () => {
    const provider = createSlackUserProvider({ clientId: undefined, clientSecret: undefined });

    expect(provider).toBeUndefined();
  });

  it("returns a provider when credentials are provided", () => {
    const provider = createSlackUserProvider({ clientId: "123.456", clientSecret: "secret" });

    expect(provider).toBeDefined();
    expect(provider?.id).toBe("slack-user");
    expect(provider?.platform).toBe("slack");
    expect(provider?.type).toBe("app_install");
  });

  describe("buildAuthorizationUrl", () => {
    it("uses user_scope instead of scope", async () => {
      const provider = createSlackUserProvider({ clientId: "123.456", clientSecret: "secret" });
      if (!provider) throw new Error("expected provider");

      const url = new URL(
        await provider.buildAuthorizationUrl("https://example.com/callback", "test-state"),
      );

      expect(url.searchParams.get("user_scope")).toBe(
        "app_configurations:write,app_configurations:read",
      );
      expect(url.searchParams.has("scope")).toBe(false);
    });

    it("includes client_id, redirect_uri, and state", async () => {
      const provider = createSlackUserProvider({ clientId: "123.456", clientSecret: "secret" });
      if (!provider) throw new Error("expected provider");

      const url = new URL(
        await provider.buildAuthorizationUrl("https://example.com/callback", "test-state"),
      );

      expect(url.searchParams.get("client_id")).toBe("123.456");
      expect(url.searchParams.get("redirect_uri")).toBe("https://example.com/callback");
      expect(url.searchParams.get("state")).toBe("test-state");
    });

    it("uses the correct Slack OAuth v2 authorize endpoint", async () => {
      const provider = createSlackUserProvider({ clientId: "123.456", clientSecret: "secret" });
      if (!provider) throw new Error("expected provider");

      const url = new URL(
        await provider.buildAuthorizationUrl("https://example.com/callback", "state"),
      );

      expect(url.origin + url.pathname).toBe("https://slack.com/oauth/v2/authorize");
    });
  });

  describe("completeInstallation", () => {
    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    });

    it("throws MISSING_CODE when code is undefined", async () => {
      const provider = createSlackUserProvider({ clientId: "123.456", clientSecret: "secret" });
      if (!provider) throw new Error("expected provider");

      await expect(
        provider.completeInstallation(undefined, "https://example.com/callback"),
      ).rejects.toMatchObject({ code: "MISSING_CODE" });
    });

    it("exchanges code for user token and returns AppInstallResult", async () => {
      const slackResponse = {
        ok: true,
        team: { id: "T024BE7LD", name: "Test Workspace" },
        authed_user: { id: "U01234", access_token: "xoxp-user-token-456" },
      };

      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(slackResponse))),
      );

      const provider = createSlackUserProvider({ clientId: "123.456", clientSecret: "secret" });
      if (!provider) throw new Error("expected provider");

      const result = await provider.completeInstallation(
        "auth-code-123",
        "https://example.com/callback",
      );

      expect(result.externalId).toBe("T024BE7LD");
      expect(result.externalName).toBe("Test Workspace");
      expect(result.credential).toMatchObject({
        type: "oauth",
        provider: "slack-user",
        label: "Test Workspace",
        secret: {
          platform: "slack-user",
          access_token: "xoxp-user-token-456",
          team_id: "T024BE7LD",
          team_name: "Test Workspace",
          user_id: "U01234",
        },
      });

      const fetchCall = vi.mocked(fetch).mock.calls[0];
      expect(fetchCall?.[0]).toBe("https://slack.com/api/oauth.v2.access");
      const opts = fetchCall?.[1];
      expect(opts?.headers).toMatchObject({ Authorization: `Basic ${btoa("123.456:secret")}` });
    });

    it("throws SLACK_OAUTH_ERROR when Slack returns ok: false", async () => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response(JSON.stringify({ ok: false, error: "invalid_code" }))),
      );

      const provider = createSlackUserProvider({ clientId: "123.456", clientSecret: "secret" });
      if (!provider) throw new Error("expected provider");

      await expect(
        provider.completeInstallation("bad-code", "https://example.com/callback"),
      ).rejects.toMatchObject({
        code: "SLACK_OAUTH_ERROR",
        message: expect.stringContaining("invalid_code"),
      });
    });
  });
});
