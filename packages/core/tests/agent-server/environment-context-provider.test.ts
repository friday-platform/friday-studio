/**
 * Tests environment variable validation that prevents agent runtime failures.
 *
 * Validates that agents receive properly configured environment variables
 * before execution, with clear error messages for missing or invalid values.
 */

import type { AgentEnvironmentConfig } from "@atlas/agent-sdk";
import type { Logger } from "@atlas/logger";
import { assertEquals, assertRejects } from "@std/assert";
import {
  createEnvironmentContext,
  getEnvironmentHelp,
} from "../../src/agent-context/environment-context.ts";

// Silent logger for tests
const mockLogger: Logger = {
  info: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => mockLogger,
};

Deno.test("Environment validation - success with required variables", async () => {
  Deno.env.set("TEST_API_KEY", "sk_test123456789");
  Deno.env.set("TEST_TOKEN", "ghp_abcdefghij1234567890");

  try {
    const validateEnvironment = createEnvironmentContext(mockLogger);

    const config: AgentEnvironmentConfig = {
      required: [
        {
          name: "TEST_API_KEY",
          description: "API key for testing",
          validation: "^sk_[a-zA-Z0-9]+$",
        },
        {
          name: "TEST_TOKEN",
          description: "GitHub token for testing",
          validation: "^ghp_[a-zA-Z0-9]+$",
        },
      ],
    };

    const result = await validateEnvironment("test-workspace", "test-agent", config);

    assertEquals(result.TEST_API_KEY, "sk_test123456789");
    assertEquals(result.TEST_TOKEN, "ghp_abcdefghij1234567890");
    assertEquals(Object.keys(result).length, 2);
  } finally {
    // Clean up
    Deno.env.delete("TEST_API_KEY");
    Deno.env.delete("TEST_TOKEN");
  }
});

Deno.test("Environment validation - success with optional variables and defaults", async () => {
  Deno.env.set("TEST_TIMEOUT", "600");

  try {
    const validateEnvironment = createEnvironmentContext(mockLogger);

    const config: AgentEnvironmentConfig = {
      optional: [
        { name: "TEST_TIMEOUT", description: "Timeout in seconds", default: "300" },
        { name: "TEST_ORG", description: "Default organization", default: "atlas-dev" },
        {
          name: "TEST_DEBUG",
          description: "Debug mode",
          // No default or env var - becomes empty string
        },
      ],
    };

    const result = await validateEnvironment("test-workspace", "test-agent", config);

    assertEquals(result.TEST_TIMEOUT, "600"); // From environment
    assertEquals(result.TEST_ORG, "atlas-dev"); // From default
    assertEquals(result.TEST_DEBUG, ""); // No default, no env var
    assertEquals(Object.keys(result).length, 3);
  } finally {
    // Clean up
    Deno.env.delete("TEST_TIMEOUT");
  }
});

Deno.test("Environment validation - success with mixed required and optional", async () => {
  Deno.env.set("REQUIRED_VAR", "required_value");

  try {
    const validateEnvironment = createEnvironmentContext(mockLogger);

    const config: AgentEnvironmentConfig = {
      required: [{ name: "REQUIRED_VAR", description: "Required variable" }],
      optional: [
        { name: "OPTIONAL_VAR", description: "Optional variable", default: "default_value" },
      ],
    };

    const result = await validateEnvironment("test-workspace", "test-agent", config);

    assertEquals(result.REQUIRED_VAR, "required_value");
    assertEquals(result.OPTIONAL_VAR, "default_value");
    assertEquals(Object.keys(result).length, 2);
  } finally {
    // Clean up
    Deno.env.delete("REQUIRED_VAR");
  }
});

Deno.test("Environment validation - success with no environment config", async () => {
  const validateEnvironment = createEnvironmentContext(mockLogger);

  const result = await validateEnvironment(
    "test-workspace",
    "test-agent",
    undefined, // No environment config
  );

  assertEquals(result, {});
  assertEquals(Object.keys(result).length, 0);
});

Deno.test("Environment validation - failure with missing required variables", async () => {
  const validateEnvironment = createEnvironmentContext(mockLogger);

  const config: AgentEnvironmentConfig = {
    required: [
      { name: "MISSING_VAR1", description: "First missing variable" },
      { name: "MISSING_VAR2", description: "Second missing variable" },
    ],
  };

  await assertRejects(
    () => validateEnvironment("test-workspace", "test-agent", config),
    Error,
    "Cannot execute test-agent in workspace 'test-workspace': Required environment variables not found: MISSING_VAR1, MISSING_VAR2. Please add these variables to your workspace .env file.",
  );
});

Deno.test("Environment validation - failure with regex validation", async () => {
  Deno.env.set("BAD_FORMAT_VAR", "wrong_format");

  try {
    const validateEnvironment = createEnvironmentContext(mockLogger);

    const config: AgentEnvironmentConfig = {
      required: [
        {
          name: "BAD_FORMAT_VAR",
          description: "Variable with strict format",
          validation: "^sk_[a-zA-Z0-9]+$",
        },
      ],
    };

    await assertRejects(
      () => validateEnvironment("test-workspace", "test-agent", config),
      Error,
      "Environment variable BAD_FORMAT_VAR failed validation pattern: ^sk_[a-zA-Z0-9]+$",
    );
  } finally {
    // Clean up
    Deno.env.delete("BAD_FORMAT_VAR");
  }
});

Deno.test("Environment validation - failure with invalid regex pattern", async () => {
  Deno.env.set("TEST_VAR", "any_value");

  try {
    const validateEnvironment = createEnvironmentContext(mockLogger);

    const config: AgentEnvironmentConfig = {
      required: [
        {
          name: "TEST_VAR",
          description: "Variable with invalid regex",
          validation: "[invalid regex",
        },
      ],
    };

    await assertRejects(
      () => validateEnvironment("test-workspace", "test-agent", config),
      Error,
      "Invalid regex pattern for TEST_VAR: [invalid regex",
    );
  } finally {
    // Clean up
    Deno.env.delete("TEST_VAR");
  }
});

Deno.test("Environment validation - mixed scenario (some missing, some present)", async () => {
  Deno.env.set("PRESENT_VAR", "present_value");

  try {
    const validateEnvironment = createEnvironmentContext(mockLogger);

    const config: AgentEnvironmentConfig = {
      required: [
        { name: "PRESENT_VAR", description: "Variable that is present" },
        { name: "MISSING_VAR", description: "Variable that is missing" },
      ],
      optional: [
        { name: "OPTIONAL_VAR", description: "Optional variable", default: "default_value" },
      ],
    };

    await assertRejects(
      () => validateEnvironment("test-workspace", "test-agent", config),
      Error,
      "Cannot execute test-agent in workspace 'test-workspace': Required environment variables not found: MISSING_VAR. Please add these variables to your workspace .env file.",
    );
  } finally {
    // Clean up
    Deno.env.delete("PRESENT_VAR");
  }
});

Deno.test("Environment help message generation", () => {
  const config: AgentEnvironmentConfig = {
    required: [
      { name: "API_KEY", description: "API key for service", validation: "^sk_[a-zA-Z0-9]+$" },
      { name: "TOKEN", description: "Authentication token" },
    ],
    optional: [
      { name: "ORG", description: "Organization name", default: "default-org" },
      { name: "DEBUG", description: "Enable debug mode" },
    ],
  };

  const help = getEnvironmentHelp(config);

  // Verify help includes all required variables with validation patterns
  assertEquals(help.includes("Required environment variables:"), true);
  assertEquals(help.includes("API_KEY: API key for service"), true);
  assertEquals(help.includes("Pattern: ^sk_[a-zA-Z0-9]+$"), true);
  assertEquals(help.includes("TOKEN: Authentication token"), true);

  // Verify help includes optional variables with defaults
  assertEquals(help.includes("Optional environment variables:"), true);
  assertEquals(help.includes("ORG: Organization name (default: default-org)"), true);
  assertEquals(help.includes("DEBUG: Enable debug mode"), true);

  // Verify help includes actionable guidance
  assertEquals(help.includes("Add these variables to your workspace .env file and retry."), true);
});

Deno.test("Environment help message - no requirements", () => {
  const config: AgentEnvironmentConfig = {};

  const help = getEnvironmentHelp(config);

  assertEquals(help, "No environment variables required for this agent.");
});
