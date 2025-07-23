// Set testing mode to disable file logging
Deno.env.set("DENO_TESTING", "true");

import { assertEquals, assertExists } from "@std/assert";
import { DraftValidator } from "../../src/draft/validation.ts";

Deno.test("DraftValidator - should validate correct workspace configuration", () => {
  const validConfig = {
    version: "1.0",
    workspace: {
      name: "test-workspace",
      description: "A test workspace",
    },
  };

  const result = DraftValidator.validateWorkspaceConfiguration(validConfig);

  assertEquals(result.valid, true);
  assertEquals(result.errors.length, 0);
  assertEquals(result.warnings.length, 0);
});

Deno.test("DraftValidator - should reject invalid workspace configuration", () => {
  const invalidConfig = {
    version: "1.0",
    // Missing required workspace field
  };

  const result = DraftValidator.validateWorkspaceConfiguration(invalidConfig);

  assertEquals(result.valid, false);
  assertExists(result.errors);
  assertEquals(result.errors.length > 0, true);
});

Deno.test("DraftValidator - should handle null/undefined config", () => {
  const nullResult = DraftValidator.validateWorkspaceConfiguration(null);
  const undefinedResult = DraftValidator.validateWorkspaceConfiguration(undefined);

  assertEquals(nullResult.valid, false);
  assertEquals(undefinedResult.valid, false);
  assertExists(nullResult.errors);
  assertExists(undefinedResult.errors);
});

Deno.test("DraftValidator - should format config as JSON", () => {
  const config = {
    version: "1.0",
    workspace: { name: "test" },
  };

  const formatted = DraftValidator.formatConfigForDisplay(config, "json");

  assertExists(formatted);
  assertEquals(formatted.includes('"version": "1.0"'), true);
  assertEquals(formatted.includes('"name": "test"'), true);
});

Deno.test("DraftValidator - should format config as summary", () => {
  const config = {
    version: "1.0",
    workspace: { name: "test" },
    agents: {},
  };

  const formatted = DraftValidator.formatConfigForDisplay(config, "summary");

  assertExists(formatted);
  assertEquals(formatted.includes("3 configuration sections"), true);
});

Deno.test("DraftValidator - should default to JSON format for unknown format", () => {
  const config = { test: "value" };

  const formatted = DraftValidator.formatConfigForDisplay(config, "unknown");
  const jsonFormatted = DraftValidator.formatConfigForDisplay(config, "json");

  assertEquals(formatted, jsonFormatted);
});
