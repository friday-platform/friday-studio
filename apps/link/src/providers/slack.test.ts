import { assert, assertEquals, assertExists } from "@std/assert";
import { SlackSecretSchema, slackProvider } from "./slack.ts";

Deno.test("SlackSecretSchema", async (t) => {
  await t.step("accepts valid xoxb- token", () => {
    const result = SlackSecretSchema.safeParse({ token: "xoxb-123-456-abc" });
    assertEquals(result.success, true);
  });

  await t.step("accepts valid xoxp- token", () => {
    const result = SlackSecretSchema.safeParse({ token: "xoxp-user-token" });
    assertEquals(result.success, true);
  });

  await t.step("rejects xoxa- token", () => {
    const result = SlackSecretSchema.safeParse({ token: "xoxa-app-token" });
    assertEquals(result.success, false);
  });

  await t.step("rejects xoxc-, xoxd-, xoxr- tokens", () => {
    assertEquals(SlackSecretSchema.safeParse({ token: "xoxc-token" }).success, false);
    assertEquals(SlackSecretSchema.safeParse({ token: "xoxd-token" }).success, false);
    assertEquals(SlackSecretSchema.safeParse({ token: "xoxr-token" }).success, false);
  });

  await t.step("rejects token without xox prefix", () => {
    const result = SlackSecretSchema.safeParse({ token: "sk-abc123" });
    assertEquals(result.success, false);
  });

  await t.step("rejects token with invalid xox suffix", () => {
    const result = SlackSecretSchema.safeParse({ token: "xoxz-invalid" });
    assertEquals(result.success, false);
  });

  await t.step("rejects missing token field", () => {
    const result = SlackSecretSchema.safeParse({});
    assertEquals(result.success, false);
  });

  await t.step("rejects empty token", () => {
    const result = SlackSecretSchema.safeParse({ token: "" });
    assertEquals(result.success, false);
  });

  await t.step("provides descriptive error message", () => {
    const result = SlackSecretSchema.safeParse({ token: "invalid" });
    assertEquals(result.success, false);
    if (!result.success) {
      const firstIssue = result.error.issues[0];
      assert(firstIssue, "Expected at least one error issue");
      const message = firstIssue.message;
      assert(
        message.includes("Invalid Slack token"),
        `Expected error message to include "Invalid Slack token", got: ${message}`,
      );
    }
  });
});

Deno.test("slackProvider.health", async (t) => {
  await t.step("returns healthy with metadata on successful auth.test", async () => {
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

    assertExists(slackProvider.health, "health function should be defined");
    const result = await slackProvider.health({ token: "xoxb-test-token" });

    assertEquals(result.healthy, true);
    if (result.healthy) {
      assertEquals(result.metadata?.teamName, "Test Workspace");
      assertEquals(result.metadata?.teamId, "T01234567");
      assertEquals(result.metadata?.userId, "U01234567");
      assertEquals(result.metadata?.botId, "B01234567");
    }
  });

  await t.step("returns unhealthy with error on invalid_auth", async () => {
    // Mock Slack auth.test with invalid_auth error
    using _mockFetch = mockFetch("https://slack.com/api/auth.test", {
      status: 200,
      body: JSON.stringify({ ok: false, error: "invalid_auth" }),
    });

    assertExists(slackProvider.health, "health function should be defined");
    const result = await slackProvider.health({ token: "xoxb-invalid-token" });

    assertEquals(result.healthy, false);
    if (!result.healthy) {
      assertEquals(result.error, "invalid_auth");
    }
  });

  await t.step("returns unhealthy with error on token_revoked", async () => {
    // Mock Slack auth.test with token_revoked error
    using _mockFetch = mockFetch("https://slack.com/api/auth.test", {
      status: 200,
      body: JSON.stringify({ ok: false, error: "token_revoked" }),
    });

    assertExists(slackProvider.health, "health function should be defined");
    const result = await slackProvider.health({ token: "xoxb-revoked-token" });

    assertEquals(result.healthy, false);
    if (!result.healthy) {
      assertEquals(result.error, "token_revoked");
    }
  });

  await t.step("returns unhealthy with error message on network error", async () => {
    // Mock fetch throwing a network error
    using _mockFetch = mockFetchError("https://slack.com/api/auth.test", "Network error");

    assertExists(slackProvider.health, "health function should be defined");
    const result = await slackProvider.health({ token: "xoxb-test-token" });

    assertEquals(result.healthy, false);
    if (!result.healthy) {
      assert(
        result.error.includes("Network error"),
        `Expected error to include "Network error", got: ${result.error}`,
      );
    }
  });

  await t.step("returns unhealthy with error on malformed JSON response", async () => {
    // Mock Slack returning invalid JSON
    using _mockFetch = mockFetch("https://slack.com/api/auth.test", {
      status: 200,
      body: "not json",
    });

    assertExists(slackProvider.health, "health function should be defined");
    const result = await slackProvider.health({ token: "xoxb-test-token" });

    assertEquals(result.healthy, false);
    if (!result.healthy) {
      assertExists(result.error);
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
