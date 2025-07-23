// Set testing mode to disable file logging
Deno.env.set("DENO_TESTING", "true");

import { assertEquals, assertExists } from "@std/assert";
import { DraftValidator } from "../../src/draft/validation.ts";

Deno.test("Draft validation - should pass with both numeric types and string numbers", () => {
  // Test with proper numeric types
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
  assertEquals(result.valid, true, "Should pass with proper numeric types");

  // Test with string numbers (should now pass with coercion)
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
          temperature: "0.1", // String number - should be coerced
          max_tokens: "2000", // String number - should be coerced
          tools: ["filesystem"],
        },
      },
    },
  };

  const stringResult = DraftValidator.validateWorkspaceConfiguration(configWithStringNumbers);
  assertEquals(stringResult.valid, true, "Should pass with string numbers due to coercion");
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
