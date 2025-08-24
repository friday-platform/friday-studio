/**
 * Tests for YAML agent parser
 */

import { assertEquals, assertThrows } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import {
  extractMCPServerNames,
  extractToolAllowlist,
  interpolateEnvironmentVariables,
  parseYAMLAgentContent,
} from "../../../src/agent-conversion/yaml/parser.ts";
import type { YAMLAgentDefinition } from "../../../src/agent-conversion/yaml/schema.ts";

describe("YAML Parser", () => {
  describe("parseYAMLAgentContent", () => {
    it("should parse valid YAML agent definition", () => {
      const yamlContent = `
agent:
  id: test-agent
  version: 1.0.0
  description: Test agent for parsing
  expertise:
    domains: ["testing"]
    capabilities: ["test operations"]
    examples: ["run a test"]

llm:
  provider: anthropic
  model: claude-3-sonnet-20240229
  prompt: You are a test agent
`;

      const result = parseYAMLAgentContent(yamlContent);

      assertEquals(result.agent.id, "test-agent");
      assertEquals(result.agent.version, "1.0.0");
      assertEquals(result.agent.expertise.domains, ["testing"]);
      assertEquals(result.llm.provider, "anthropic");
    });

    it("should validate required fields", () => {
      const invalidYaml = `
agent:
  id: test-agent
  # missing version and description
  expertise:
    domains: ["testing"]
`;

      assertThrows(() => parseYAMLAgentContent(invalidYaml), Error, "Failed to parse YAML agent");
    });

    it("should handle environment variable interpolation", () => {
      const yamlContent = `
agent:
  id: test-agent
  version: 1.0.0
  description: Agent with env vars
  expertise:
    domains: ["testing"]
    capabilities: ["test operations"]
    examples: ["run a test"]

environment:
  required:
    - name: API_KEY
      description: "API key is \${API_KEY}"
      validation: "^sk-"

llm:
  provider: anthropic
  model: \${MODEL_NAME:-claude-3-sonnet-20240229}
  prompt: You are a test agent
`;

      const env = { API_KEY: "sk-12345", MODEL_NAME: "claude-3-opus-20240229" };

      const result = parseYAMLAgentContent(yamlContent, { env });

      assertEquals(result.environment?.required?.[0]?.description, "API key is sk-12345");
      assertEquals(result.llm.model, "claude-3-opus-20240229");
    });

    it("should use default values for environment variables", () => {
      const yamlContent = `
agent:
  id: test-agent
  version: 1.0.0
  description: Test agent
  expertise:
    domains: ["testing"]
    capabilities: ["test operations"]
    examples: ["run a test"]

llm:
  provider: anthropic
  model: \${MISSING_VAR:-default-model}
  prompt: You are a test agent
`;

      const result = parseYAMLAgentContent(yamlContent);
      assertEquals(result.llm.model, "default-model");
    });

    it("should validate environment requirements", () => {
      const yamlContent = `
agent:
  id: test-agent
  version: 1.0.0
  description: Test agent
  expertise:
    domains: ["testing"]
    capabilities: ["test operations"]
    examples: ["run a test"]

environment:
  required:
    - name: REQUIRED_VAR
      description: This is required
      validation: "^test-"

llm:
  provider: anthropic
  model: claude-3-sonnet-20240229
  prompt: You are a test agent
`;

      // Should fail validation when required var is missing
      assertThrows(
        () => parseYAMLAgentContent(yamlContent, { validateEnv: true }),
        Error,
        "Environment validation failed",
      );

      // Should pass when required var is provided
      const result = parseYAMLAgentContent(yamlContent, {
        env: { REQUIRED_VAR: "test-value" },
        validateEnv: true,
      });
      assertEquals(result.agent.id, "test-agent");
    });
  });

  describe("interpolateEnvironmentVariables", () => {
    it("should interpolate simple variables", () => {
      const content = "Hello ${NAME}, your key is ${API_KEY}";
      const env = { NAME: "Alice", API_KEY: "secret123" };

      const result = interpolateEnvironmentVariables(content, env);
      assertEquals(result, "Hello Alice, your key is secret123");
    });

    it("should handle defaults", () => {
      const content = "Model: ${MODEL:-gpt-4}, Region: ${REGION:-us-east-1}";
      const env = { MODEL: "claude" };

      const result = interpolateEnvironmentVariables(content, env);
      assertEquals(result, "Model: claude, Region: us-east-1");
    });

    it("should leave unmatched variables as-is", () => {
      const content = "Missing: ${UNDEFINED_VAR}";

      const result = interpolateEnvironmentVariables(content, {});
      assertEquals(result, "Missing: ${UNDEFINED_VAR}");
    });
  });

  describe("extractMCPServerNames", () => {
    it("should extract server names from definition", () => {
      const definition: YAMLAgentDefinition = {
        agent: {
          id: "test",
          version: "1.0.0",
          description: "Test",
          expertise: { domains: ["test"], capabilities: ["test"], examples: [] },
        },
        mcp_servers: {
          github: { transport: { type: "stdio", command: "test" } },
          slack: { transport: { type: "stdio", command: "test" } },
        },
        llm: { provider: "anthropic", model: "claude-3-sonnet-20240229", prompt: "Test" },
      };

      const names = extractMCPServerNames(definition);
      assertEquals(names.sort(), ["github", "slack"]);
    });

    it("should return empty array when no servers", () => {
      const definition: YAMLAgentDefinition = {
        agent: {
          id: "test",
          version: "1.0.0",
          description: "Test",
          expertise: { domains: ["test"], capabilities: ["test"], examples: [] },
        },
        llm: { provider: "anthropic", model: "claude-3-sonnet-20240229", prompt: "Test" },
      };

      const names = extractMCPServerNames(definition);
      assertEquals(names, []);
    });
  });

  describe("extractToolAllowlist", () => {
    it("should extract tool allowlist for server", () => {
      const definition: YAMLAgentDefinition = {
        agent: {
          id: "test",
          version: "1.0.0",
          description: "Test",
          expertise: { domains: ["test"], capabilities: ["test"], examples: [] },
        },
        mcp_servers: {
          github: {
            transport: { type: "stdio", command: "test" },
            tools: { allow: ["search_code", "get_file"] },
          },
        },
        llm: { provider: "anthropic", model: "claude-3-sonnet-20240229", prompt: "Test" },
      };

      const allowlist = extractToolAllowlist(definition, "github");
      assertEquals(allowlist, ["search_code", "get_file"]);
    });

    it("should return undefined when no allowlist", () => {
      const definition: YAMLAgentDefinition = {
        agent: {
          id: "test",
          version: "1.0.0",
          description: "Test",
          expertise: { domains: ["test"], capabilities: ["test"], examples: [] },
        },
        mcp_servers: { github: { transport: { type: "stdio", command: "test" } } },
        llm: { provider: "anthropic", model: "claude-3-sonnet-20240229", prompt: "Test" },
      };

      const allowlist = extractToolAllowlist(definition, "github");
      assertEquals(allowlist, undefined);
    });
  });
});
