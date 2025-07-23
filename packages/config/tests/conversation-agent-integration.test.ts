/**
 * Integration test for conversation agent workspace creation with numeric coercion
 *
 * This test simulates the exact flow where a conversation agent creates a workspace
 * configuration with quoted numeric values, demonstrating the fix in action.
 */

import { assertEquals } from "@std/assert";
import { parse as parseYaml } from "@std/yaml";
import { ConfigLoader, WorkspaceAgentConfigSchema } from "@atlas/config";

// Mock adapter that simulates conversation agent generated YAML
class MockConversationAdapter {
  constructor(private workspacePath: string) {}

  async readYaml(_path: string): Promise<unknown> {
    // This simulates YAML that a conversation agent might generate
    // with quoted numeric values (the original problem)
    const conversationGeneratedYaml = `
version: "1.0"
workspace:
  name: "downloads-organizer"
  description: "Organizes downloaded files by type and date"

agents:
  file-classifier:
    type: "llm" 
    description: "Classifies files by type and importance"
    config:
      provider: "anthropic"
      model: "claude-3-7-sonnet-latest"
      prompt: "You are a file classification expert"
      temperature: "0.3"        # Quoted number - was causing validation errors
      max_tokens: "1500"        # Quoted number - was causing validation errors
      max_steps: "8"            # Quoted number - was causing validation errors
      max_retries: "2"          # Quoted number - was causing validation errors
      tools: ["filesystem"]

jobs:
  organize-download:
    description: "Classify and organize downloaded files"
    execution:
      strategy: "sequential"
      agents:
        - "file-classifier"
`;

    return Promise.resolve(parseYaml(conversationGeneratedYaml));
  }

  async exists(_path: string): Promise<boolean> {
    return Promise.resolve(true);
  }

  getWorkspacePath(): string {
    return this.workspacePath;
  }
}

Deno.test("Conversation Agent Integration - quoted numbers in workspace creation", async () => {
  const adapter = new MockConversationAdapter("/test-workspace");
  const loader = new ConfigLoader(adapter, "/test-workspace");

  // This should work without validation errors due to numeric coercion
  const config = await loader.loadWorkspace();

  // Verify the structure is correct
  assertEquals(config.version, "1.0");
  assertEquals(config.workspace.name, "downloads-organizer");

  // Verify LLM agent numeric coercion
  const llmAgent = config.agents?.["file-classifier"];
  if (llmAgent && llmAgent.type === "llm") {
    assertEquals(llmAgent.config.temperature, 0.3);
    assertEquals(typeof llmAgent.config.temperature, "number");
    assertEquals(llmAgent.config.max_tokens, 1500);
    assertEquals(typeof llmAgent.config.max_tokens, "number");
    assertEquals(llmAgent.config.max_steps, 8);
    assertEquals(typeof llmAgent.config.max_steps, "number");
    assertEquals(llmAgent.config.max_retries, 2);
    assertEquals(typeof llmAgent.config.max_retries, "number");
  }

  // Verify workspace structure is intact
  assertEquals(
    config.jobs?.["organize-download"]?.description,
    "Classify and organize downloaded files",
  );
});

Deno.test("Direct Schema Validation - comprehensive agent config coercion", () => {
  // Test all numeric fields across different agent types with string inputs
  const testConfigs = [
    {
      name: "LLM Agent with all numeric fields as strings",
      config: {
        type: "llm",
        description: "Test LLM agent",
        config: {
          provider: "anthropic",
          model: "claude-3-7-sonnet-latest",
          prompt: "Test prompt",
          temperature: "0.7",
          max_tokens: "2000",
          max_steps: "10",
          max_retries: "3",
        },
      },
      expected: {
        temperature: 0.7,
        max_tokens: 2000,
        max_steps: 10,
        max_retries: 3,
      },
    },
    {
      name: "System Agent with all numeric fields as strings",
      config: {
        type: "system",
        agent: "test-agent",
        description: "Test system agent",
        config: {
          model: "claude-3-5-haiku-latest",
          temperature: "0.5",
          max_tokens: "1500",
          max_reasoning_steps: "8",
        },
      },
      expected: {
        temperature: 0.5,
        max_tokens: 1500,
        max_reasoning_steps: 8,
      },
    },
    {
      name: "Remote Agent with numeric fields as strings",
      config: {
        type: "remote",
        description: "Test remote agent",
        config: {
          protocol: "acp",
          endpoint: "https://api.example.com/agent",
          agent_name: "remote-test",
          max_retries: "5",
          health_check_interval: "30s",
        },
      },
      expected: {
        max_retries: 5,
      },
    },
  ];

  testConfigs.forEach(({ name, config, expected }) => {
    const result = WorkspaceAgentConfigSchema.safeParse(config);
    assertEquals(result.success, true, `${name} should parse successfully`);

    if (result.success) {
      // Verify numeric coercion worked
      Object.entries(expected).forEach(([key, expectedValue]) => {
        const actualValue = (result.data.config as Record<string, unknown>)?.[key];
        assertEquals(
          actualValue,
          expectedValue,
          `${name}: ${key} should be coerced to ${expectedValue}`,
        );
        assertEquals(typeof actualValue, "number", `${name}: ${key} should be a number type`);
      });
    }
  });
});

Deno.test("Error Cases - invalid numeric strings still fail appropriately", () => {
  const invalidConfigs = [
    {
      name: "Invalid temperature string",
      config: {
        type: "llm",
        description: "Test agent",
        config: {
          provider: "anthropic",
          model: "claude-3-7-sonnet-latest",
          prompt: "Test",
          temperature: "not_a_number",
        },
      },
    },
    {
      name: "Out of range temperature after coercion",
      config: {
        type: "llm",
        description: "Test agent",
        config: {
          provider: "anthropic",
          model: "claude-3-7-sonnet-latest",
          prompt: "Test",
          temperature: "1.5", // Valid number but outside 0-1 range
        },
      },
    },
    {
      name: "Negative max_tokens after coercion",
      config: {
        type: "llm",
        description: "Test agent",
        config: {
          provider: "anthropic",
          model: "claude-3-7-sonnet-latest",
          prompt: "Test",
          max_tokens: "-100", // Valid number but negative
        },
      },
    },
  ];

  invalidConfigs.forEach(({ name, config }) => {
    const result = WorkspaceAgentConfigSchema.safeParse(config);
    assertEquals(result.success, false, `${name} should fail validation`);
  });
});

Deno.test("Mixed Numeric Types - handles both strings and numbers correctly", () => {
  // Real-world scenario: some fields are strings, some are already numbers
  const mixedConfig = {
    type: "llm",
    description: "Mixed numeric types agent",
    config: {
      provider: "anthropic",
      model: "claude-3-7-sonnet-latest",
      prompt: "Test prompt",
      temperature: 0.7, // Already a number
      max_tokens: "2000", // String that needs coercion
      max_steps: 5, // Already a number
      max_retries: "3", // String that needs coercion
    },
  };

  const result = WorkspaceAgentConfigSchema.safeParse(mixedConfig);
  assertEquals(result.success, true, "Mixed numeric types should parse successfully");

  if (result.success && result.data.type === "llm") {
    // Type is narrowed to LLM agent, so config properties are known
    assertEquals(result.data.config.temperature, 0.7);
    assertEquals(typeof result.data.config.temperature, "number");
    assertEquals(result.data.config.max_tokens, 2000);
    assertEquals(typeof result.data.config.max_tokens, "number");
    assertEquals(result.data.config.max_steps, 5);
    assertEquals(typeof result.data.config.max_steps, "number");
    assertEquals(result.data.config.max_retries, 3);
    assertEquals(typeof result.data.config.max_retries, "number");
  }
});
