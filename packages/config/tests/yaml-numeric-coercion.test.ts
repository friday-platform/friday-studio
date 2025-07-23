/**
 * Tests for YAML parsing and numeric coercion in configuration schemas
 *
 * This test suite demonstrates the core issue: when YAML contains quoted numbers,
 * they're parsed as strings but schemas expect numbers. Zod coercion fixes this.
 */

import { assertEquals } from "@std/assert";
import { parse as parseYaml } from "@std/yaml";
import { WorkspaceAgentConfigSchema, WorkspaceConfigSchema } from "@atlas/config";

interface YamlWorkspaceData {
  agents: Record<string, unknown>;
}

interface YamlAgentData {
  config: Record<string, unknown>;
}

Deno.test("YAML Parsing - demonstrates the core issue", () => {
  // This is what the conversation agent might generate
  const yamlWithQuotedNumbers = `
version: "1.0"
workspace:
  name: "test-workspace"
  description: "Test workspace"
agents:
  my-agent:
    type: "llm"
    description: "Test agent"
    config:
      provider: "anthropic"
      model: "claude-3-7-sonnet-latest"
      prompt: "Test prompt"
      temperature: "0.7"    # Quoted number - becomes string
      max_tokens: "2000"    # Quoted number - becomes string
      max_steps: "5"        # Quoted number - becomes string
`;

  const yamlWithUnquotedNumbers = `
version: "1.0"
workspace:
  name: "test-workspace"
  description: "Test workspace"
agents:
  my-agent:
    type: "llm"
    description: "Test agent"
    config:
      provider: "anthropic"
      model: "claude-3-7-sonnet-latest"
      prompt: "Test prompt"
      temperature: 0.7      # Unquoted number - becomes number
      max_tokens: 2000      # Unquoted number - becomes number
      max_steps: 5          # Unquoted number - becomes number
`;

  // Parse both YAML variants
  const quotedParsed = parseYaml(yamlWithQuotedNumbers) as YamlWorkspaceData;
  const unquotedParsed = parseYaml(yamlWithUnquotedNumbers) as YamlWorkspaceData;

  // Verify the types after YAML parsing
  const quotedAgent = quotedParsed.agents["my-agent"] as YamlAgentData;
  const unquotedAgent = unquotedParsed.agents["my-agent"] as YamlAgentData;

  // Quoted numbers become strings
  assertEquals(typeof quotedAgent.config.temperature, "string");
  assertEquals(typeof quotedAgent.config.max_tokens, "string");
  assertEquals(typeof quotedAgent.config.max_steps, "string");
  assertEquals(quotedAgent.config.temperature, "0.7");
  assertEquals(quotedAgent.config.max_tokens, "2000");
  assertEquals(quotedAgent.config.max_steps, "5");

  // Unquoted numbers become numbers
  assertEquals(typeof unquotedAgent.config.temperature, "number");
  assertEquals(typeof unquotedAgent.config.max_tokens, "number");
  assertEquals(typeof unquotedAgent.config.max_steps, "number");
  assertEquals(unquotedAgent.config.temperature, 0.7);
  assertEquals(unquotedAgent.config.max_tokens, 2000);
  assertEquals(unquotedAgent.config.max_steps, 5);
});

Deno.test("Schema Validation - numeric coercion works with quoted numbers", () => {
  const yamlWithQuotedNumbers = `
agents:
  test-agent:
    type: "llm"
    description: "Test agent"
    config:
      provider: "anthropic"
      model: "claude-3-7-sonnet-latest"
      prompt: "Test prompt"
      temperature: "0.7"
      max_tokens: "2000"
      max_steps: "5"
`;

  const parsed = parseYaml(yamlWithQuotedNumbers) as YamlWorkspaceData;
  const agentConfig = parsed.agents["test-agent"];

  // This should now SUCCEED because z.coerce.number() handles string conversion
  const result = WorkspaceAgentConfigSchema.safeParse(agentConfig);

  assertEquals(result.success, true, "Schema should accept quoted numbers with coercion");

  if (result.success && result.data.type === "llm") {
    // Verify coercion worked correctly - type is narrowed to LLM agent
    assertEquals(result.data.config.temperature, 0.7);
    assertEquals(typeof result.data.config.temperature, "number");
    assertEquals(result.data.config.max_tokens, 2000);
    assertEquals(typeof result.data.config.max_tokens, "number");
    assertEquals(result.data.config.max_steps, 5);
    assertEquals(typeof result.data.config.max_steps, "number");
  }
});

Deno.test("Schema Validation - unquoted numbers work correctly", () => {
  const yamlWithUnquotedNumbers = `
agents:
  test-agent:
    type: "llm"
    description: "Test agent"
    config:
      provider: "anthropic"
      model: "claude-3-7-sonnet-latest"
      prompt: "Test prompt"
      temperature: 0.7
      max_tokens: 2000
      max_steps: 5
`;

  const parsed = parseYaml(yamlWithUnquotedNumbers) as YamlWorkspaceData;
  const agentConfig = parsed.agents["test-agent"];

  // This should always work
  const result = WorkspaceAgentConfigSchema.safeParse(agentConfig);
  assertEquals(result.success, true);

  if (result.success && result.data.type === "llm") {
    // Type is narrowed to LLM agent, so config properties are known
    assertEquals(result.data.config.temperature, 0.7);
    assertEquals(typeof result.data.config.temperature, "number");
    assertEquals(result.data.config.max_tokens, 2000);
    assertEquals(typeof result.data.config.max_tokens, "number");
    assertEquals(result.data.config.max_steps, 5);
    assertEquals(typeof result.data.config.max_steps, "number");
  }
});

Deno.test("Full Workspace Config - YAML parsing integration", () => {
  // This represents what happens when conversation agent creates a workspace
  const problematicYaml = `
version: "1.0"
workspace:
  name: "ai-generated-workspace"
  description: "Created by conversation agent"
agents:
  file-organizer:
    type: "llm"
    description: "Organizes files intelligently"
    config:
      provider: "anthropic"
      model: "claude-3-7-sonnet-latest"
      prompt: "You organize files"
      temperature: "0.1"      # LLM often quotes numeric values
      max_tokens: "2000"      # This is the core problem
      max_steps: "5"          # All become strings after YAML parsing
      tools: ["filesystem"]
jobs:
  organize-files:
    description: "Organize files job"
    execution:
      strategy: "sequential"
      agents:
        - "file-organizer"
`;

  const parsed = parseYaml(problematicYaml);

  // Full workspace parsing - this should now succeed with coercion
  const result = WorkspaceConfigSchema.safeParse(parsed);

  assertEquals(result.success, true, "Full workspace config should parse with numeric coercion");

  if (result.success) {
    // Verify coercion worked correctly
    const agent = result.data.agents?.["file-organizer"];
    if (agent && agent.type === "llm") {
      assertEquals(agent.config.temperature, 0.1);
      assertEquals(typeof agent.config.temperature, "number");
      assertEquals(agent.config.max_tokens, 2000);
      assertEquals(typeof agent.config.max_tokens, "number");
      assertEquals(agent.config.max_steps, 5);
      assertEquals(typeof agent.config.max_steps, "number");
    }
  }
});

Deno.test("Edge Cases - YAML numeric strings behavior", () => {
  const yamlWithEdgeCases = `
config:
  temperature: "0.7"          # Decimal string
  max_tokens: "2000"          # Integer string  
  max_steps: "5"              # Small integer string
  invalid_temp: "not_a_number" # Should fail validation
  zero_value: "0"             # Zero as string
  decimal_zero: "0.0"         # Decimal zero as string
`;

  const parsed = parseYaml(yamlWithEdgeCases) as Record<string, unknown>;
  const parsedConfig = parsed.config as Record<string, unknown>;

  // Verify YAML parsing behavior
  assertEquals(typeof parsedConfig.temperature, "string");
  assertEquals(typeof parsedConfig.max_tokens, "string");
  assertEquals(typeof parsedConfig.max_steps, "string");
  assertEquals(typeof parsedConfig.invalid_temp, "string");
  assertEquals(typeof parsedConfig.zero_value, "string");
  assertEquals(typeof parsedConfig.decimal_zero, "string");

  assertEquals(parsedConfig.temperature, "0.7");
  assertEquals(parsedConfig.max_tokens, "2000");
  assertEquals(parsedConfig.max_steps, "5");
  assertEquals(parsedConfig.invalid_temp, "not_a_number");
  assertEquals(parsedConfig.zero_value, "0");
  assertEquals(parsedConfig.decimal_zero, "0.0");
});
