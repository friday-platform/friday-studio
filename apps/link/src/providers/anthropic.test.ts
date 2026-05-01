import { describe, expect, it } from "vitest";
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

describe("AnthropicSecretSchema", () => {
  it("accepts valid sk-ant-api03- key", () => {
    const result = AnthropicSecretSchema.safeParse({ api_key: "sk-ant-api03-abc123def456" });
    expect(result.success).toEqual(true);
  });

  it("accepts valid sk-ant-admin- key", () => {
    const result = AnthropicSecretSchema.safeParse({ api_key: "sk-ant-admin-abc123def456" });
    expect(result.success).toEqual(true);
  });

  it("rejects key without sk-ant- prefix", () => {
    const result = AnthropicSecretSchema.safeParse({ api_key: "sk-abc123def456" });
    expect(result.success).toEqual(false);
  });

  it("rejects OpenAI-style key", () => {
    const result = AnthropicSecretSchema.safeParse({ api_key: "sk-proj-abc123" });
    expect(result.success).toEqual(false);
  });

  it("rejects empty key", () => {
    const result = AnthropicSecretSchema.safeParse({ api_key: "" });
    expect(result.success).toEqual(false);
  });

  it("rejects missing api_key field", () => {
    const result = AnthropicSecretSchema.safeParse({});
    expect(result.success).toEqual(false);
  });

  it("provides descriptive error message", () => {
    const result = AnthropicSecretSchema.safeParse({ api_key: "invalid" });
    expect(result.success).toEqual(false);
    if (!result.success) {
      const firstIssue = result.error.issues[0];
      expect(firstIssue).toBeDefined();
      const message = firstIssue?.message;
      expect(message).toContain("Invalid Anthropic API key");
    }
  });
});

describe("anthropicProvider.health", () => {
  it("returns healthy with modelsAvailable on success", async () => {
    using _mockFetch = mockFetch("https://api.anthropic.com/v1/models", {
      status: 200,
      body: JSON.stringify({
        data: [
          { id: "claude-opus-4-6" },
          { id: "claude-sonnet-4-6" },
          { id: "claude-haiku-4-5-20251001" },
        ],
      }),
    });

    if (!anthropicProvider.health) throw new Error("health should be defined");
    const result = await anthropicProvider.health({ api_key: "sk-ant-api03-test" });

    expect(result.healthy).toEqual(true);
    if (result.healthy) {
      expect(result.metadata?.modelsAvailable).toEqual(3);
    }
  });

  it("returns unhealthy with error on authentication_error", async () => {
    using _mockFetch = mockFetch("https://api.anthropic.com/v1/models", {
      status: 401,
      body: JSON.stringify({ error: { message: "Invalid API key provided" } }),
    });

    if (!anthropicProvider.health) throw new Error("health should be defined");
    const result = await anthropicProvider.health({ api_key: "sk-ant-api03-invalid" });

    expect(result.healthy).toEqual(false);
    if (!result.healthy) {
      expect(result.error).toEqual("Invalid API key provided");
    }
  });

  it("returns unhealthy with error on network error", async () => {
    using _mockFetch = mockFetchError("https://api.anthropic.com/v1/models", "Network error");

    if (!anthropicProvider.health) throw new Error("health should be defined");
    const result = await anthropicProvider.health({ api_key: "sk-ant-api03-test" });

    expect(result.healthy).toEqual(false);
    if (!result.healthy) {
      expect(result.error).toContain("Network error");
    }
  });

  it("returns unhealthy on malformed JSON response", async () => {
    using _mockFetch = mockFetch("https://api.anthropic.com/v1/models", {
      status: 200,
      body: "not json",
    });

    if (!anthropicProvider.health) throw new Error("health should be defined");
    const result = await anthropicProvider.health({ api_key: "sk-ant-api03-test" });

    expect(result.healthy).toEqual(false);
    if (!result.healthy) {
      expect(result.error).toBeDefined();
    }
  });

  it("handles empty data array", async () => {
    using _mockFetch = mockFetch("https://api.anthropic.com/v1/models", {
      status: 200,
      body: JSON.stringify({ data: [] }),
    });

    if (!anthropicProvider.health) throw new Error("health should be defined");
    const result = await anthropicProvider.health({ api_key: "sk-ant-api03-test" });

    expect(result.healthy).toEqual(true);
    if (result.healthy) {
      expect(result.metadata?.modelsAvailable).toEqual(0);
    }
  });
});

/**
 * Mock fetch for a specific URL with a Response
 */
function mockFetch(url: string, responseInit: { status: number; body: string }): Disposable {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = function patchedFetch(
    input: URL | RequestInfo,
    init?: RequestInit,
  ): Promise<Response> {
    const inputUrl = extractUrlFromInput(input);
    if (inputUrl === url) {
      return Promise.resolve(
        new Response(responseInit.body, {
          status: responseInit.status,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    return originalFetch(input, init);
  };

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
  globalThis.fetch = function patchedFetch(
    input: URL | RequestInfo,
    init?: RequestInit,
  ): Promise<Response> {
    const inputUrl = extractUrlFromInput(input);
    if (inputUrl === url) {
      return Promise.reject(new Error(errorMessage));
    }
    return originalFetch(input, init);
  };

  return {
    [Symbol.dispose]: () => {
      globalThis.fetch = originalFetch;
    },
  };
}
