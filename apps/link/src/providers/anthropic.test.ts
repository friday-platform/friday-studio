import { assert, assertEquals, assertExists } from "@std/assert";
import { z } from "zod";
import { AnthropicSecretSchema, anthropicProvider } from "./anthropic.ts";

// Duck-type schemas for extracting URL from fetch input
const UrlLikeSchema = z.object({ href: z.string() });
const RequestLikeSchema = z.object({ url: z.string() });

/**
 * Extract URL string from fetch input using Zod duck-typing
 * instead of instanceof checks (which can fail across realms)
 */
function extractUrlFromInput(input: string | URL | Request): string {
  if (typeof input === "string") return input;

  const urlResult = UrlLikeSchema.safeParse(input);
  if (urlResult.success) return urlResult.data.href;

  const requestResult = RequestLikeSchema.safeParse(input);
  if (requestResult.success) return requestResult.data.url;

  throw new Error("Cannot extract URL from fetch input");
}

Deno.test("AnthropicSecretSchema", async (t) => {
  await t.step("accepts valid sk-ant-api03- key", () => {
    const result = AnthropicSecretSchema.safeParse({ api_key: "sk-ant-api03-abc123def456" });
    assertEquals(result.success, true);
  });

  await t.step("accepts valid sk-ant-admin- key", () => {
    const result = AnthropicSecretSchema.safeParse({ api_key: "sk-ant-admin-abc123def456" });
    assertEquals(result.success, true);
  });

  await t.step("rejects key without sk-ant- prefix", () => {
    const result = AnthropicSecretSchema.safeParse({ api_key: "sk-abc123def456" });
    assertEquals(result.success, false);
  });

  await t.step("rejects OpenAI-style key", () => {
    const result = AnthropicSecretSchema.safeParse({ api_key: "sk-proj-abc123" });
    assertEquals(result.success, false);
  });

  await t.step("rejects empty key", () => {
    const result = AnthropicSecretSchema.safeParse({ api_key: "" });
    assertEquals(result.success, false);
  });

  await t.step("rejects missing api_key field", () => {
    const result = AnthropicSecretSchema.safeParse({});
    assertEquals(result.success, false);
  });

  await t.step("provides descriptive error message", () => {
    const result = AnthropicSecretSchema.safeParse({ api_key: "invalid" });
    assertEquals(result.success, false);
    if (!result.success) {
      const firstIssue = result.error.issues[0];
      assert(firstIssue, "Expected at least one error issue");
      const message = firstIssue.message;
      assert(
        message.includes("Invalid Anthropic API key"),
        `Expected error message to include "Invalid Anthropic API key", got: ${message}`,
      );
    }
  });
});

Deno.test("anthropicProvider.health", async (t) => {
  await t.step("returns healthy with modelsAvailable on success", async () => {
    using _mockFetch = mockFetch("https://api.anthropic.com/v1/models", {
      status: 200,
      body: JSON.stringify({
        data: [
          { id: "claude-3-opus-20240229" },
          { id: "claude-3-sonnet-20240229" },
          { id: "claude-3-haiku-20240307" },
        ],
      }),
    });

    assertExists(anthropicProvider.health, "health function should be defined");
    const result = await anthropicProvider.health({ api_key: "sk-ant-api03-test" });

    assertEquals(result.healthy, true);
    if (result.healthy) {
      assertEquals(result.metadata?.modelsAvailable, 3);
    }
  });

  await t.step("returns unhealthy with error on authentication_error", async () => {
    using _mockFetch = mockFetch("https://api.anthropic.com/v1/models", {
      status: 401,
      body: JSON.stringify({ error: { message: "Invalid API key provided" } }),
    });

    assertExists(anthropicProvider.health, "health function should be defined");
    const result = await anthropicProvider.health({ api_key: "sk-ant-api03-invalid" });

    assertEquals(result.healthy, false);
    if (!result.healthy) {
      assertEquals(result.error, "Invalid API key provided");
    }
  });

  await t.step("returns unhealthy with error on network error", async () => {
    using _mockFetch = mockFetchError("https://api.anthropic.com/v1/models", "Network error");

    assertExists(anthropicProvider.health, "health function should be defined");
    const result = await anthropicProvider.health({ api_key: "sk-ant-api03-test" });

    assertEquals(result.healthy, false);
    if (!result.healthy) {
      assert(
        result.error.includes("Network error"),
        `Expected error to include "Network error", got: ${result.error}`,
      );
    }
  });

  await t.step("returns unhealthy on malformed JSON response", async () => {
    using _mockFetch = mockFetch("https://api.anthropic.com/v1/models", {
      status: 200,
      body: "not json",
    });

    assertExists(anthropicProvider.health, "health function should be defined");
    const result = await anthropicProvider.health({ api_key: "sk-ant-api03-test" });

    assertEquals(result.healthy, false);
    if (!result.healthy) {
      assertExists(result.error);
    }
  });

  await t.step("handles empty data array", async () => {
    using _mockFetch = mockFetch("https://api.anthropic.com/v1/models", {
      status: 200,
      body: JSON.stringify({ data: [] }),
    });

    assertExists(anthropicProvider.health, "health function should be defined");
    const result = await anthropicProvider.health({ api_key: "sk-ant-api03-test" });

    assertEquals(result.healthy, true);
    if (result.healthy) {
      assertEquals(result.metadata?.modelsAvailable, 0);
    }
  });
});

/**
 * Mock fetch for a specific URL with a Response
 */
function mockFetch(url: string, responseInit: { status: number; body: string }): Disposable {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    const inputUrl = extractUrlFromInput(input);
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
    const inputUrl = extractUrlFromInput(input);
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
