import process from "node:process";
import { describe, expect, it } from "vitest";
import { UserConfigurationError } from "../errors/user-configuration-error.ts";
import { createEnvironmentContext } from "./environment-context.ts";

// Mock logger - cast to bypass full interface requirement
const mockLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => mockLogger,
} as Parameters<typeof createEnvironmentContext>[0];

// Helper to create required env var config
const reqVar = (name: string, validation?: string) => ({
  name,
  description: `Test ${name}`,
  ...(validation && { validation }),
});

describe("validateEnvironment", () => {
  it("returns empty env when no config", async () => {
    const validate = createEnvironmentContext(mockLogger);
    const result = await validate("workspace", "agent", undefined);
    expect(result).toEqual({});
  });

  it("passes when required var exists", async () => {
    process.env.TEST_VAR = "test-value";
    try {
      const validate = createEnvironmentContext(mockLogger);
      const result = await validate("workspace", "agent", { required: [reqVar("TEST_VAR")] });
      expect(result).toEqual({ TEST_VAR: "test-value" });
    } finally {
      delete process.env.TEST_VAR;
    }
  });

  it("throws UserConfigurationError when required var missing", async () => {
    delete process.env.MISSING_VAR;
    const validate = createEnvironmentContext(mockLogger);

    await expect(
      validate("workspace", "agent", { required: [reqVar("MISSING_VAR")] }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(UserConfigurationError);
      expect(error).toHaveProperty("message");
      expect((error as Error).message).toMatch(
        /Required environment variables not found: MISSING_VAR/,
      );
      return true;
    });
  });

  it("LITELLM_API_KEY substitutes for ANTHROPIC_API_KEY", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.LITELLM_API_KEY = "sk-litellm-test";
    try {
      const validate = createEnvironmentContext(mockLogger);
      // Should not throw - LITELLM_API_KEY satisfies the requirement
      await validate("workspace", "agent", { required: [reqVar("ANTHROPIC_API_KEY")] });
    } finally {
      delete process.env.LITELLM_API_KEY;
    }
  });

  it("prefers primary key over LITELLM substitute", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-primary";
    process.env.LITELLM_API_KEY = "sk-litellm-test";
    try {
      const validate = createEnvironmentContext(mockLogger);
      const result = await validate("workspace", "agent", {
        required: [reqVar("ANTHROPIC_API_KEY")],
      });

      // Primary key should be used, not the substitute
      expect(result).toHaveProperty("ANTHROPIC_API_KEY", "sk-ant-primary");
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.LITELLM_API_KEY;
    }
  });

  it("throws UserConfigurationError when both primary and LITELLM missing", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.LITELLM_API_KEY;
    const validate = createEnvironmentContext(mockLogger);

    await expect(
      validate("workspace", "agent", { required: [reqVar("ANTHROPIC_API_KEY")] }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(UserConfigurationError);
      expect(error).toHaveProperty("message");
      expect((error as Error).message).toMatch(
        /Required environment variables not found: ANTHROPIC_API_KEY/,
      );
      return true;
    });
  });

  it("LITELLM does not substitute for non-LLM keys", async () => {
    delete process.env.SOME_OTHER_KEY;
    process.env.LITELLM_API_KEY = "sk-litellm-test";
    try {
      const validate = createEnvironmentContext(mockLogger);

      await expect(
        validate("workspace", "agent", { required: [reqVar("SOME_OTHER_KEY")] }),
      ).rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(UserConfigurationError);
        expect(error).toHaveProperty("message");
        expect((error as Error).message).toMatch(
          /Required environment variables not found: SOME_OTHER_KEY/,
        );
        return true;
      });
    } finally {
      delete process.env.LITELLM_API_KEY;
    }
  });

  it("skips regex validation for LITELLM substitute", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.LITELLM_API_KEY = "sk-litellm-test";
    try {
      const validate = createEnvironmentContext(mockLogger);
      // Pattern ^sk-ant- would fail for LITELLM key, but validation should be skipped
      await validate("workspace", "agent", { required: [reqVar("ANTHROPIC_API_KEY", "^sk-ant-")] });
    } finally {
      delete process.env.LITELLM_API_KEY;
    }
  });

  it("runs regex validation for primary key", async () => {
    process.env.ANTHROPIC_API_KEY = "invalid-key";
    try {
      const validate = createEnvironmentContext(mockLogger);
      await expect(
        validate("workspace", "agent", { required: [reqVar("ANTHROPIC_API_KEY", "^sk-ant-")] }),
      ).rejects.toThrow("failed validation pattern");
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("LITELLM does not substitute when linkRef is present", async () => {
    // When linkRef is specified, Link credential takes precedence over LITELLM fallback.
    // This prevents proxy keys from being used where real provider keys are needed
    // (e.g., Claude Code needs real sk-ant-* key for Claude CLI).
    //
    // A provider-only linkRef resolves through the shared resolver, which fetches
    // the provider's *default* credential — so we mock the default endpoint.
    const originalFetch = globalThis.fetch;
    const realApiKey = "sk-ant-real-key-from-link";
    const credId = "cred_anthropic_123";

    globalThis.fetch = (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.includes("/credentials/default/anthropic")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              credential: {
                id: credId,
                provider: "anthropic",
                type: "apikey",
                secret: { api_key: realApiKey },
              },
              status: "valid",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }

      return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
    };

    delete process.env.ANTHROPIC_API_KEY;
    process.env.LITELLM_API_KEY = "sk-litellm-should-not-be-used";
    try {
      const validate = createEnvironmentContext(mockLogger);
      const result = await validate("workspace", "agent", {
        required: [
          {
            name: "ANTHROPIC_API_KEY",
            description: "Anthropic API key",
            linkRef: { provider: "anthropic", key: "api_key" },
          },
        ],
      });

      // Link credential should be used, NOT the LITELLM fallback
      expect(result).toHaveProperty("ANTHROPIC_API_KEY", realApiKey);
    } finally {
      delete process.env.LITELLM_API_KEY;
      globalThis.fetch = originalFetch;
    }
  });

  it("throws UserConfigurationError with cause when credential refresh fails", async () => {
    // Tests the API failure path: when Link HTTP call fails (network error, 500, etc),
    // throws UserConfigurationError with original error preserved as cause.
    const originalFetch = globalThis.fetch;
    const apiError = new Error("Link service unavailable");

    // The default-credential endpoint fails with a non-404 error.
    globalThis.fetch = (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.includes("/credentials/default/")) {
        return Promise.reject(apiError);
      }

      return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
    };

    delete process.env.GOOGLE_CALENDAR_ACCESS_TOKEN;
    try {
      const validate = createEnvironmentContext(mockLogger);

      await expect(
        validate("workspace", "agent", {
          required: [
            {
              name: "GOOGLE_CALENDAR_ACCESS_TOKEN",
              description: "Google Calendar OAuth token",
              linkRef: { provider: "google-calendar", key: "access_token" },
            },
          ],
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(UserConfigurationError);
        expect(error).toHaveProperty("message");
        expect((error as Error).message).toMatch(/credentials could not be refreshed/);
        expect(error).toHaveProperty("cause");
        expect((error as Error).cause).toBeInstanceOf(Error);
        return true;
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("treats an unconnected provider as a soft miss (required var)", async () => {
    // A 404 from the default-credential endpoint means the user simply hasn't
    // connected the provider — surfaced as a missing-configuration error, not
    // a hard failure.
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/credentials/default/")) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: "not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
    };

    delete process.env.SLACK_TOKEN;
    try {
      const validate = createEnvironmentContext(mockLogger);
      await expect(
        validate("workspace", "agent", {
          required: [
            {
              name: "SLACK_TOKEN",
              description: "Slack token",
              linkRef: { provider: "slack", key: "access_token" },
            },
          ],
        }),
      ).rejects.toBeInstanceOf(UserConfigurationError);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("resolves an optional var from its linkRef", async () => {
    // Optional-var linkRefs were previously accepted by the schema and silently
    // dropped — they now resolve through the shared resolver.
    const originalFetch = globalThis.fetch;
    const token = "xoxb-optional-from-link";

    globalThis.fetch = (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/credentials/default/slack")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              credential: {
                id: "cred_slack_1",
                provider: "slack",
                type: "oauth",
                secret: { access_token: token },
              },
              status: "valid",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
    };

    delete process.env.SLACK_TOKEN;
    try {
      const validate = createEnvironmentContext(mockLogger);
      const result = await validate("workspace", "agent", {
        optional: [
          {
            name: "SLACK_TOKEN",
            description: "Slack token",
            linkRef: { provider: "slack", key: "access_token" },
          },
        ],
      });
      expect(result).toHaveProperty("SLACK_TOKEN", token);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("falls back to the declared default when an optional linkRef cannot resolve", async () => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/credentials/default/")) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: "not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
    };

    delete process.env.OPTIONAL_VAR;
    try {
      const validate = createEnvironmentContext(mockLogger);
      const result = await validate("workspace", "agent", {
        optional: [
          {
            name: "OPTIONAL_VAR",
            description: "Optional var",
            default: "fallback-value",
            linkRef: { provider: "slack", key: "access_token" },
          },
        ],
      });
      expect(result).toHaveProperty("OPTIONAL_VAR", "fallback-value");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
