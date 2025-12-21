import process from "node:process";
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
  process.env.TEST_VAR = "test-value";
  try {
    const validate = createEnvironmentContext(mockLogger);
    const result = await validate("workspace", "agent", { required: [reqVar("TEST_VAR")] });
    assertEquals(result, { TEST_VAR: "test-value" });
  } finally {
    delete process.env.TEST_VAR;
  }
});

Deno.test("validateEnvironment - throws when required var missing", () => {
  delete process.env.MISSING_VAR;
  const validate = createEnvironmentContext(mockLogger);
  assertThrows(
    () => validate("workspace", "agent", { required: [reqVar("MISSING_VAR")] }),
    Error,
    "Required environment variables not found MISSING_VAR",
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

Deno.test("validateEnvironment - throws when both primary and LITELLM missing", () => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.LITELLM_API_KEY;
  const validate = createEnvironmentContext(mockLogger);
  assertThrows(
    () => validate("workspace", "agent", { required: [reqVar("ANTHROPIC_API_KEY")] }),
    Error,
    "Required environment variables not found ANTHROPIC_API_KEY",
  );
});

Deno.test("validateEnvironment - LITELLM does not substitute for non-LLM keys", () => {
  delete process.env.SOME_OTHER_KEY;
  process.env.LITELLM_API_KEY = "sk-litellm-test";
  try {
    const validate = createEnvironmentContext(mockLogger);
    assertThrows(
      () => validate("workspace", "agent", { required: [reqVar("SOME_OTHER_KEY")] }),
      Error,
      "Required environment variables not found SOME_OTHER_KEY",
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

Deno.test("validateEnvironment - runs regex validation for primary key", () => {
  process.env.ANTHROPIC_API_KEY = "invalid-key";
  try {
    const validate = createEnvironmentContext(mockLogger);
    assertThrows(
      () => validate("workspace", "agent", { required: [reqVar("ANTHROPIC_API_KEY", "^sk-ant-")] }),
      Error,
      "failed validation pattern",
    );
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
});
