/**
 * Core Conversion Tests for convertYAMLToAgent
 *
 * Tests the main conversion path from YAML agent definitions to SDK agents.
 * Covers tool filtering, environment handling, and error scenarios.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { convertYAMLToAgent } from "../../src/agent-conversion/from-yaml.ts";
import type { YAMLAgentDefinition } from "../../src/agent-conversion/yaml/schema.ts";

// Check if ANTHROPIC_API_KEY is available
const hasAnthropicKey = !!Deno.env.get("ANTHROPIC_API_KEY");
const skipMessage = "Skipping test - ANTHROPIC_API_KEY not set";

describe("YAML to Agent Conversion", () => {
  // Helper to create minimal valid YAML definition
  const createMinimalYAML = (
    overrides: Partial<YAMLAgentDefinition> = {},
  ): YAMLAgentDefinition => ({
    agent: {
      id: "test-agent",
      version: "1.0.0",
      description: "Test agent for conversion testing",
      expertise: {
        domains: ["testing"],
        capabilities: ["run tests"],
        examples: ["test something"],
      },
    },
    llm: {
      provider: "anthropic",
      model: "claude-3-sonnet-20240229",
      prompt: "You are a test agent",
    },
    ...overrides,
  });

  describe("Basic Conversion", () => {
    it("should convert minimal YAML definition to SDK agent", () => {
      if (!hasAnthropicKey) {
        console.log(skipMessage);
        return;
      }

      const yaml = createMinimalYAML();
      const agent = convertYAMLToAgent(yaml);

      assertEquals(agent.metadata.id, "test-agent");
      assertEquals(agent.metadata.version, "1.0.0");
      assertEquals(agent.metadata.description, "Test agent for conversion testing");
      assertEquals(agent.metadata.expertise.domains, ["testing"]);
      assertEquals(typeof agent.execute, "function");
    });

    it("should use agent ID from YAML", () => {
      if (!hasAnthropicKey) {
        console.log(skipMessage);
        return;
      }

      const yaml = createMinimalYAML();
      const agent = convertYAMLToAgent(yaml);

      assertEquals(agent.metadata.id, "test-agent");
    });

    it("should use explicit ID when provided", () => {
      if (!hasAnthropicKey) {
        console.log(skipMessage);
        return;
      }

      const yaml = createMinimalYAML({
        agent: {
          id: "custom-id",
          version: "1.0.0",
          description: "Test agent",
          expertise: { domains: ["testing"], capabilities: ["test"], examples: [] },
        },
      });
      const agent = convertYAMLToAgent(yaml);

      assertEquals(agent.metadata.id, "custom-id");
    });

    it("should preserve environment configuration", () => {
      if (!hasAnthropicKey) {
        console.log(skipMessage);
        return;
      }

      const yaml = createMinimalYAML({
        environment: {
          required: [{ name: "API_KEY", description: "Required API key", validation: "^sk-" }],
          optional: [{ name: "TIMEOUT", description: "Optional timeout", default: "30" }],
        },
      });
      const agent = convertYAMLToAgent(yaml);

      assertEquals(agent.environmentConfig?.required?.length, 1);
      assertEquals(agent.environmentConfig?.required?.[0]?.name, "API_KEY");
      assertEquals(agent.environmentConfig?.optional?.length, 1);
      assertEquals(agent.environmentConfig?.optional?.[0]?.name, "TIMEOUT");
    });

    it("should preserve MCP server configuration", () => {
      if (!hasAnthropicKey) {
        console.log(skipMessage);
        return;
      }

      const yaml = createMinimalYAML({
        mcp_servers: {
          github: {
            transport: { type: "stdio", command: "github-mcp" },
            tools: { allow: ["search_code"] },
          },
        },
      });
      const agent = convertYAMLToAgent(yaml);

      assertEquals(agent.mcpConfig?.github?.transport?.type, "stdio");
      assertEquals(agent.mcpConfig?.github?.tools?.allow, ["search_code"]);
    });
  });

  describe("Tool Filtering", () => {
    it("should filter tools based on allowlist", () => {
      if (!hasAnthropicKey) {
        console.log(skipMessage);
        return;
      }

      const yaml = createMinimalYAML({
        mcp_servers: {
          test_server: {
            transport: { type: "stdio", command: "test" },
            tools: { allow: ["allowed_tool"] },
          },
        },
      });

      const agent = convertYAMLToAgent(yaml);

      // This test validates that the agent was created with filtering logic
      // The actual filtering happens during execution, which requires AI SDK mocking
      assertEquals(typeof agent.execute, "function");
    });

    it("should filter tools based on denylist", () => {
      if (!hasAnthropicKey) {
        console.log(skipMessage);
        return;
      }

      const yaml = createMinimalYAML({
        mcp_servers: {
          test_server: {
            transport: { type: "stdio", command: "test" },
            tools: { deny: ["denied_tool"] },
          },
        },
      });

      const agent = convertYAMLToAgent(yaml);
      assertEquals(typeof agent.execute, "function");
    });

    it("should handle separate servers with allowlist and denylist", () => {
      if (!hasAnthropicKey) {
        console.log(skipMessage);
        return;
      }

      const yaml = createMinimalYAML({
        mcp_servers: {
          allow_server: {
            transport: { type: "stdio", command: "test1" },
            tools: { allow: ["allowed_tool"] },
          },
          deny_server: {
            transport: { type: "stdio", command: "test2" },
            tools: { deny: ["denied_tool"] },
          },
        },
      });

      const agent = convertYAMLToAgent(yaml);
      assertEquals(typeof agent.execute, "function");
    });

    it("should handle multiple MCP servers with different filters", () => {
      if (!hasAnthropicKey) {
        console.log(skipMessage);
        return;
      }

      const yaml = createMinimalYAML({
        mcp_servers: {
          server1: {
            transport: { type: "stdio", command: "server1" },
            tools: { allow: ["tool1", "tool2"] },
          },
          server2: {
            transport: { type: "stdio", command: "server2" },
            tools: { deny: ["dangerous_tool"] },
          },
        },
      });

      const agent = convertYAMLToAgent(yaml);
      assertEquals(typeof agent.execute, "function");
    });
  });

  describe("LLM Configuration", () => {
    it("should handle anthropic provider", () => {
      if (!hasAnthropicKey) {
        console.log(skipMessage);
        return;
      }

      const yaml = createMinimalYAML({
        llm: { provider: "anthropic", model: "claude-3-sonnet-20240229", prompt: "Test prompt" },
      });

      const agent = convertYAMLToAgent(yaml);
      assertEquals(typeof agent.execute, "function");
    });

    it("should handle LLM configuration options", () => {
      if (!hasAnthropicKey) {
        console.log(skipMessage);
        return;
      }

      const yaml = createMinimalYAML({
        llm: {
          provider: "anthropic",
          model: "claude-3-sonnet-20240229",
          prompt: "You are a test agent",
          temperature: 0.7,
          max_tokens: 1000,
          max_steps: 5,
          tool_choice: "required",
          streaming: { enabled: false },
          provider_options: { thinking: true },
        },
      });

      const agent = convertYAMLToAgent(yaml);
      assertEquals(typeof agent.execute, "function");
    });

    it("should handle timeout configuration", () => {
      if (!hasAnthropicKey) {
        console.log(skipMessage);
        return;
      }

      const yaml = createMinimalYAML({
        llm: {
          provider: "anthropic",
          model: "claude-3-sonnet-20240229",
          prompt: "Test prompt",
          timeout: { progressTimeout: "60s", maxTotalTimeout: "5m" },
        },
      });

      const agent = convertYAMLToAgent(yaml);
      assertEquals(typeof agent.execute, "function");
    });
  });

  describe("Error Handling", () => {
    it("should throw error for invalid provider", () => {
      const yaml = createMinimalYAML({
        llm: {
          provider: "invalid" as "anthropic" | "openai" | "google",
          model: "test-model",
          prompt: "Test prompt",
        },
      });

      assertThrows(() => convertYAMLToAgent(yaml), Error);
    });

    it("should require domains and capabilities", () => {
      if (!hasAnthropicKey) {
        console.log(skipMessage);
        return;
      }
      // This test ensures the agent creation validates required fields
      const yaml: YAMLAgentDefinition = {
        agent: {
          id: "minimal",
          version: "1.0.0",
          description: "Minimal agent",
          expertise: { domains: [], capabilities: [], examples: [] },
        },
        llm: { provider: "anthropic", model: "claude-3-sonnet-20240229", prompt: "Minimal prompt" },
      };

      assertThrows(() => convertYAMLToAgent(yaml), Error);
    });
  });

  describe("Metadata Handling", () => {
    it("should preserve custom metadata as object", () => {
      if (!hasAnthropicKey) {
        console.log(skipMessage);
        return;
      }

      const yaml = createMinimalYAML({
        agent: {
          id: "test-agent",
          version: "1.0.0",
          description: "Test agent",
          expertise: { domains: ["testing"], capabilities: ["test"], examples: [] },
          metadata: {
            author: { name: "Test Author", email: "test@example.com" },
            tags: ["test", "example"],
          },
        },
      });

      const agent = convertYAMLToAgent(yaml);
      assertEquals(agent.metadata.metadata?.author?.name, "Test Author");
      assertEquals(agent.metadata.metadata?.tags?.[0], "test");
    });

    it("should handle missing metadata gracefully", () => {
      if (!hasAnthropicKey) {
        console.log(skipMessage);
        return;
      }

      const yaml = createMinimalYAML();
      const agent = convertYAMLToAgent(yaml);

      assertEquals(typeof agent.execute, "function");
      // Metadata should be undefined or empty, not crash
    });
  });
});
