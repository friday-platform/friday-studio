import { describe, expect, it } from "vitest";
import { SlackSecretSchema, slackProvider } from "./slack.ts";

describe("SlackSecretSchema", () => {
  it("accepts valid xoxb- token", () => {
    const result = SlackSecretSchema.safeParse({ access_token: "xoxb-123-456-abc" });
    expect(result.success).toEqual(true);
  });

  it("accepts valid xoxp- token", () => {
    const result = SlackSecretSchema.safeParse({ access_token: "xoxp-user-token" });
    expect(result.success).toEqual(true);
  });

  it("rejects xoxa- token", () => {
    const result = SlackSecretSchema.safeParse({ access_token: "xoxa-app-token" });
    expect(result.success).toEqual(false);
  });

  it("rejects xoxc-, xoxd-, xoxr- tokens", () => {
    expect(SlackSecretSchema.safeParse({ access_token: "xoxc-token" }).success).toEqual(false);
    expect(SlackSecretSchema.safeParse({ access_token: "xoxd-token" }).success).toEqual(false);
    expect(SlackSecretSchema.safeParse({ access_token: "xoxr-token" }).success).toEqual(false);
  });

  it("rejects token without xox prefix", () => {
    const result = SlackSecretSchema.safeParse({ access_token: "sk-abc123" });
    expect(result.success).toEqual(false);
  });

  it("rejects token with invalid xox suffix", () => {
    const result = SlackSecretSchema.safeParse({ access_token: "xoxz-invalid" });
    expect(result.success).toEqual(false);
  });

  it("rejects missing token field", () => {
    const result = SlackSecretSchema.safeParse({});
    expect(result.success).toEqual(false);
  });

  it("rejects empty token", () => {
    const result = SlackSecretSchema.safeParse({ access_token: "" });
    expect(result.success).toEqual(false);
  });

  it("provides descriptive error message", () => {
    const result = SlackSecretSchema.safeParse({ access_token: "invalid" });
    expect(result.success).toEqual(false);
    if (!result.success) {
      const firstIssue = result.error.issues[0];
      expect(firstIssue).toBeDefined();
      const message = firstIssue!.message;
      expect(message).toContain("Invalid Slack token");
    }
  });
});

describe("slackProvider.health", () => {
  it("returns healthy with metadata on successful auth.test", async () => {
    // Mock successful Slack auth.test response
    using _mockFetch = mockFetch("https://slack.com/api/auth.test", {
      status: 200,
      body: JSON.stringify({
        ok: true,
        url: "https://test-workspace.slack.com/",
        team: "Test Workspace",
        user: "test_user",
        team_id: "T01234567",
        user_id: "U01234567",
        bot_id: "B01234567",
      }),
    });

    expect(slackProvider.health).toBeDefined();
    const result = await slackProvider.health!({ access_token: "xoxb-test-token" });

    expect(result.healthy).toEqual(true);
    if (result.healthy) {
      expect(result.metadata?.teamName).toEqual("Test Workspace");
      expect(result.metadata?.teamId).toEqual("T01234567");
      expect(result.metadata?.userId).toEqual("U01234567");
      expect(result.metadata?.botId).toEqual("B01234567");
    }
  });

  it("returns unhealthy with error on invalid_auth", async () => {
    // Mock Slack auth.test with invalid_auth error
    using _mockFetch = mockFetch("https://slack.com/api/auth.test", {
      status: 200,
      body: JSON.stringify({ ok: false, error: "invalid_auth" }),
    });

    expect(slackProvider.health).toBeDefined();
    const result = await slackProvider.health!({ access_token: "xoxb-invalid-token" });

    expect(result.healthy).toEqual(false);
    if (!result.healthy) {
      expect(result.error).toEqual("invalid_auth");
    }
  });

  it("returns unhealthy with error on token_revoked", async () => {
    // Mock Slack auth.test with token_revoked error
    using _mockFetch = mockFetch("https://slack.com/api/auth.test", {
      status: 200,
      body: JSON.stringify({ ok: false, error: "token_revoked" }),
    });

    expect(slackProvider.health).toBeDefined();
    const result = await slackProvider.health!({ access_token: "xoxb-revoked-token" });

    expect(result.healthy).toEqual(false);
    if (!result.healthy) {
      expect(result.error).toEqual("token_revoked");
    }
  });

  it("returns unhealthy with error message on network error", async () => {
    // Mock fetch throwing a network error
    using _mockFetch = mockFetchError("https://slack.com/api/auth.test", "Network error");

    expect(slackProvider.health).toBeDefined();
    const result = await slackProvider.health!({ access_token: "xoxb-test-token" });

    expect(result.healthy).toEqual(false);
    if (!result.healthy) {
      expect(result.error).toContain("Network error");
    }
  });

  it("returns unhealthy with error on malformed JSON response", async () => {
    // Mock Slack returning invalid JSON
    using _mockFetch = mockFetch("https://slack.com/api/auth.test", {
      status: 200,
      body: "not json",
    });

    expect(slackProvider.health).toBeDefined();
    const result = await slackProvider.health!({ access_token: "xoxb-test-token" });

    expect(result.healthy).toEqual(false);
    if (!result.healthy) {
      expect(result.error).toBeDefined();
    }
  });
});

/**
 * Mock fetch for a specific URL with a Response
 */
function mockFetch(url: string, responseInit: { status: number; body: string }): Disposable {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    const inputUrl =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (inputUrl === url) {
      return Promise.resolve(
        new Response(responseInit.body, {
          status: responseInit.status,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    return originalFetch(input);
  }) as typeof fetch;

  return {
    [Symbol.dispose]: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

/**
 * Mock fetch for a specific URL to throw an error
 */
function mockFetchError(url: string, errorMessage: string): Disposable {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    const inputUrl =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (inputUrl === url) {
      return Promise.reject(new Error(errorMessage));
    }
    return originalFetch(input);
  }) as typeof fetch;

  return {
    [Symbol.dispose]: () => {
      globalThis.fetch = originalFetch;
    },
  };
}
