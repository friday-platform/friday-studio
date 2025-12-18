import { assertEquals, assertThrows } from "@std/assert";
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
  Deno.env.set("TEST_VAR", "test-value");
  try {
    const validate = createEnvironmentContext(mockLogger);
    const result = await validate("workspace", "agent", { required: [reqVar("TEST_VAR")] });
    assertEquals(result, { TEST_VAR: "test-value" });
  } finally {
    Deno.env.delete("TEST_VAR");
  }
});

Deno.test("validateEnvironment - throws when required var missing", () => {
  Deno.env.delete("MISSING_VAR");
  const validate = createEnvironmentContext(mockLogger);
  assertThrows(
    () => validate("workspace", "agent", { required: [reqVar("MISSING_VAR")] }),
    Error,
    "Required environment variables not found MISSING_VAR",
  );
});

Deno.test("validateEnvironment - LITELLM_API_KEY substitutes for ANTHROPIC_API_KEY", async () => {
  Deno.env.delete("ANTHROPIC_API_KEY");
  Deno.env.set("LITELLM_API_KEY", "sk-litellm-test");
  try {
    const validate = createEnvironmentContext(mockLogger);
    // Should not throw - LITELLM_API_KEY satisfies the requirement
    await validate("workspace", "agent", { required: [reqVar("ANTHROPIC_API_KEY")] });
  } finally {
    Deno.env.delete("LITELLM_API_KEY");
  }
});

Deno.test("validateEnvironment - prefers primary key over LITELLM substitute", async () => {
  Deno.env.set("ANTHROPIC_API_KEY", "sk-ant-primary");
  Deno.env.set("LITELLM_API_KEY", "sk-litellm-test");
  try {
    const validate = createEnvironmentContext(mockLogger);
    const result = await validate("workspace", "agent", {
      required: [reqVar("ANTHROPIC_API_KEY")],
    });
    // Primary key should be used, not the substitute
    assertEquals(result.ANTHROPIC_API_KEY, "sk-ant-primary");
  } finally {
    Deno.env.delete("ANTHROPIC_API_KEY");
    Deno.env.delete("LITELLM_API_KEY");
  }
});

Deno.test("validateEnvironment - throws when both primary and LITELLM missing", () => {
  Deno.env.delete("ANTHROPIC_API_KEY");
  Deno.env.delete("LITELLM_API_KEY");
  const validate = createEnvironmentContext(mockLogger);
  assertThrows(
    () => validate("workspace", "agent", { required: [reqVar("ANTHROPIC_API_KEY")] }),
    Error,
    "Required environment variables not found ANTHROPIC_API_KEY",
  );
});

Deno.test("validateEnvironment - LITELLM does not substitute for non-LLM keys", () => {
  Deno.env.delete("SOME_OTHER_KEY");
  Deno.env.set("LITELLM_API_KEY", "sk-litellm-test");
  try {
    const validate = createEnvironmentContext(mockLogger);
    assertThrows(
      () => validate("workspace", "agent", { required: [reqVar("SOME_OTHER_KEY")] }),
      Error,
      "Required environment variables not found SOME_OTHER_KEY",
    );
  } finally {
    Deno.env.delete("LITELLM_API_KEY");
  }
});

Deno.test("validateEnvironment - skips regex validation for LITELLM substitute", async () => {
  Deno.env.delete("ANTHROPIC_API_KEY");
  Deno.env.set("LITELLM_API_KEY", "sk-litellm-test");
  try {
    const validate = createEnvironmentContext(mockLogger);
    // Pattern ^sk-ant- would fail for LITELLM key, but validation should be skipped
    await validate("workspace", "agent", { required: [reqVar("ANTHROPIC_API_KEY", "^sk-ant-")] });
  } finally {
    Deno.env.delete("LITELLM_API_KEY");
  }
});

Deno.test("validateEnvironment - runs regex validation for primary key", () => {
  Deno.env.set("ANTHROPIC_API_KEY", "invalid-key");
  try {
    const validate = createEnvironmentContext(mockLogger);
    assertThrows(
      () => validate("workspace", "agent", { required: [reqVar("ANTHROPIC_API_KEY", "^sk-ant-")] }),
      Error,
      "failed validation pattern",
    );
  } finally {
    Deno.env.delete("ANTHROPIC_API_KEY");
  }
});
