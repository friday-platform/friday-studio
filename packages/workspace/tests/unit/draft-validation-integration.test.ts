// Set testing mode to disable file logging
Deno.env.set("DENO_TESTING", "true");

import { assertEquals, assertExists } from "@std/assert";
import { DraftValidator } from "../../src/draft/validation.ts";

Deno.test("Draft validation - should reject string numbers without type coercion", () => {
  // This represents the real-world case where YAML numbers become JSON strings
  const configWithStringNumbers = {
    version: "1.0",
    workspace: {
      name: "downloads-cleaner",
      description: "Test workspace",
    },
    agents: {
      "file-organizer": {
        type: "llm",
        description: "Test agent",
        config: {
          provider: "anthropic",
          model: "claude-3-7-sonnet-latest",
          prompt: "Test prompt",
          temperature: "0.1", // String but should be number 0.1
          max_tokens: "2000", // String but should be number 2000
          tools: ["filesystem"],
        },
      },
    },
  };

  const result = DraftValidator.validateWorkspaceConfiguration(configWithStringNumbers);

  // Without type coercion, this should fail with proper validation errors
  assertEquals(result.valid, false, "Should fail when numbers are provided as strings");
  assertEquals(result.errors.length, 1, "Should have validation errors");
});

Deno.test("Draft validation - should pass with proper numeric types", () => {
  const configWithNumbers = {
    version: "1.0",
    workspace: {
      name: "downloads-cleaner",
      description: "Test workspace",
    },
    agents: {
      "file-organizer": {
        type: "llm",
        description: "Test agent",
        config: {
          provider: "anthropic",
          model: "claude-3-7-sonnet-latest",
          prompt: "Test prompt",
          temperature: 0.1, // Proper number
          max_tokens: 2000, // Proper number
          tools: ["filesystem"],
        },
      },
    },
  };

  const result = DraftValidator.validateWorkspaceConfiguration(configWithNumbers);

  // This should pass
  if (!result.valid) {
    console.log("Unexpected validation errors:", result.errors);
  }
  assertEquals(result.valid, true, "Should pass with proper numeric types");
});

Deno.test("Draft validation - should fail with truly invalid string values", () => {
  const configWithInvalidStrings = {
    version: "1.0",
    workspace: {
      name: "downloads-cleaner",
      description: "Test workspace",
    },
    agents: {
      "file-organizer": {
        type: "llm",
        description: "Test agent",
        config: {
          provider: "anthropic",
          model: "claude-3-7-sonnet-latest",
          prompt: "Test prompt",
          temperature: "not-a-number", // Invalid string
          max_tokens: "also-invalid", // Invalid string
          tools: ["filesystem"],
        },
      },
    },
  };

  const result = DraftValidator.validateWorkspaceConfiguration(configWithInvalidStrings);

  // This should definitely fail
  assertEquals(result.valid, false, "Should fail with non-numeric strings");
  assertExists(result.errors);
});
