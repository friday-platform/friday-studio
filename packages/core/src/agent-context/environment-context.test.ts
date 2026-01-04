import process from "node:process";
import { assertEquals, assertRejects } from "@std/assert";
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

Deno.test("validateEnvironment - returns empty env when no config", async () => {
  const validate = createEnvironmentContext(mockLogger);
  const result = await validate("workspace", "agent", undefined);
  assertEquals(result, {});
});

Deno.test("validateEnvironment - passes when required var exists", async () => {
  process.env.TEST_VAR = "test-value";
  try {
    const validate = createEnvironmentContext(mockLogger);
    const result = await validate("workspace", "agent", { required: [reqVar("TEST_VAR")] });
    assertEquals(result, { TEST_VAR: "test-value" });
  } finally {
    delete process.env.TEST_VAR;
  }
});

Deno.test("validateEnvironment - throws when required var missing", async () => {
  delete process.env.MISSING_VAR;
  const validate = createEnvironmentContext(mockLogger);
  await assertRejects(
    () => validate("workspace", "agent", { required: [reqVar("MISSING_VAR")] }),
    Error,
    "Required environment variables not found: MISSING_VAR",
  );
});

Deno.test("validateEnvironment - LITELLM_API_KEY substitutes for ANTHROPIC_API_KEY", async () => {
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

Deno.test("validateEnvironment - prefers primary key over LITELLM substitute", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-ant-primary";
  process.env.LITELLM_API_KEY = "sk-litellm-test";
  try {
    const validate = createEnvironmentContext(mockLogger);
    const result = await validate("workspace", "agent", {
      required: [reqVar("ANTHROPIC_API_KEY")],
    });
    // Primary key should be used, not the substitute
    assertEquals(result.ANTHROPIC_API_KEY, "sk-ant-primary");
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.LITELLM_API_KEY;
  }
});

Deno.test("validateEnvironment - throws when both primary and LITELLM missing", async () => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.LITELLM_API_KEY;
  const validate = createEnvironmentContext(mockLogger);
  await assertRejects(
    () => validate("workspace", "agent", { required: [reqVar("ANTHROPIC_API_KEY")] }),
    Error,
    "Required environment variables not found: ANTHROPIC_API_KEY",
  );
});

Deno.test("validateEnvironment - LITELLM does not substitute for non-LLM keys", async () => {
  delete process.env.SOME_OTHER_KEY;
  process.env.LITELLM_API_KEY = "sk-litellm-test";
  try {
    const validate = createEnvironmentContext(mockLogger);
    await assertRejects(
      () => validate("workspace", "agent", { required: [reqVar("SOME_OTHER_KEY")] }),
      Error,
      "Required environment variables not found: SOME_OTHER_KEY",
    );
  } finally {
    delete process.env.LITELLM_API_KEY;
  }
});

Deno.test("validateEnvironment - skips regex validation for LITELLM substitute", async () => {
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

Deno.test("validateEnvironment - runs regex validation for primary key", async () => {
  process.env.ANTHROPIC_API_KEY = "invalid-key";
  try {
    const validate = createEnvironmentContext(mockLogger);
    await assertRejects(
      () => validate("workspace", "agent", { required: [reqVar("ANTHROPIC_API_KEY", "^sk-ant-")] }),
      Error,
      "failed validation pattern",
    );
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
});

Deno.test("validateEnvironment - shows connect message when user hasn't linked account", async () => {
  // Mock fetch to return empty credentials, triggering CredentialNotFoundError.
  // This tests the new code path: user hasn't connected → "Please connect your account"
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({ providers: [], credentials: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

  delete process.env.GOOGLE_CALENDAR_ACCESS_TOKEN;
  try {
    const validate = createEnvironmentContext(mockLogger);
    await assertRejects(
      () =>
        validate("workspace", "agent", {
          required: [
            {
              name: "GOOGLE_CALENDAR_ACCESS_TOKEN",
              description: "Google Calendar OAuth token",
              linkRef: { provider: "google-calendar", key: "access_token" },
            },
          ],
        }),
      Error,
      "Please connect your google-calendar account to continue",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("validateEnvironment - shows reconnect message when Link API fails", async () => {
  // Tests the API failure path: when Link HTTP call fails with a
  // non-CredentialNotFoundError, users see "credentials could not be loaded".
  delete process.env.GOOGLE_CALENDAR_ACCESS_TOKEN;
  const validate = createEnvironmentContext(mockLogger);
  await assertRejects(
    () =>
      validate("workspace", "agent", {
        required: [
          {
            name: "GOOGLE_CALENDAR_ACCESS_TOKEN",
            description: "Google Calendar OAuth token",
            linkRef: { provider: "google-calendar", key: "access_token" },
          },
        ],
      }),
    Error,
    "credentials could not be loaded",
  );
});
