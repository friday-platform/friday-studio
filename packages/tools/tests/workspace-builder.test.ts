/**
 * Unit tests for WorkspaceBuilder class
 */

import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import type {
  JobSpecification,
  MCPServerConfig,
  WorkspaceAgentConfig,
  WorkspaceSignalConfig,
} from "@atlas/config";
import { WorkspaceBuilder } from "../src/internal/workspace-creation/builder.ts";

describe("WorkspaceBuilder", () => {
  function createBuilder(): WorkspaceBuilder {
    return new WorkspaceBuilder();
  }

  describe("Identity initialization", () => {
    it("should initialize workspace with valid identity", () => {
      const builder = createBuilder();
      const result = builder.initialize({
        name: "test-workspace",
        description: "Test workspace description",
      });

      assertEquals(result.success, true);
      assertEquals(result.errors.length, 0);
    });

    it("should require identity before exporting config", () => {
      const builder = createBuilder();
      try {
        builder.exportConfig();
        throw new Error("Should have thrown an error");
      } catch (error) {
        assertStringIncludes(
          (error as Error).message,
          "Cannot export configuration without workspace identity",
        );
      }
    });
  });

  describe("Signal management", () => {
    function createInitializedBuilder(): WorkspaceBuilder {
      const builder = createBuilder();
      builder.initialize({ name: "test-workspace", description: "Test workspace" });
      return builder;
    }

    it("should add valid schedule signal", () => {
      const builder = createInitializedBuilder();
      const signalConfig: WorkspaceSignalConfig = {
        provider: "schedule",
        description: "Test schedule signal",
        config: {
          schedule: "0 * * * *",
          timezone: "UTC",
        },
      };

      const result = builder.addSignal("test-signal", signalConfig);
      assertEquals(result.success, true);
      assertEquals(result.errors.length, 0);
    });

    it("should add valid HTTP signal", () => {
      const builder = createInitializedBuilder();
      const signalConfig: WorkspaceSignalConfig = {
        provider: "http",
        description: "Test HTTP signal",
        config: {
          path: "/webhook/test",
        },
      };

      const result = builder.addSignal("http-signal", signalConfig);
      assertEquals(result.success, true);
      assertEquals(result.errors.length, 0);
    });

    it("should prevent duplicate signal names", () => {
      const builder = createInitializedBuilder();
      const signalConfig: WorkspaceSignalConfig = {
        provider: "schedule",
        description: "Test signal",
        config: { schedule: "0 * * * *", timezone: "UTC" },
      };

      builder.addSignal("duplicate-signal", signalConfig);
      const result = builder.addSignal("duplicate-signal", signalConfig);

      assertEquals(result.success, false);
      assertEquals(result.errors.length > 0, true);
      assertStringIncludes(result.errors[0]!, "already exists");
    });

    it("should validate signal configuration schema", () => {
      const builder = createInitializedBuilder();
      const invalidSignalConfig: WorkspaceSignalConfig = {
        // @ts-expect-error Testing invalid provider type for validation
        provider: "invalid-provider",
        description: "Invalid signal",
        // @ts-expect-error Testing invalid provider type for validation
        config: {},
      };

      const result = builder.addSignal("invalid-signal", invalidSignalConfig);
      assertEquals(result.success, false);
      assertEquals(result.errors.length > 0, true);
    });
  });

  describe("Agent management", () => {
    function createInitializedBuilder(): WorkspaceBuilder {
      const builder = createBuilder();
      builder.initialize({ name: "test-workspace", description: "Test workspace" });
      return builder;
    }

    it("should add valid LLM agent", () => {
      const builder = createInitializedBuilder();
      const agentConfig: WorkspaceAgentConfig = {
        type: "llm",
        description: "Test LLM agent",
        config: {
          provider: "anthropic",
          model: "claude-3-5-sonnet-latest",
          prompt: "You are a test agent",
          temperature: 0.3,
        },
      };

      const result = builder.addAgent("llm-agent", agentConfig);
      assertEquals(result.success, true);
      assertEquals(result.errors.length, 0);
    });

    it("should add valid remote agent", () => {
      const builder = createInitializedBuilder();
      const agentConfig: WorkspaceAgentConfig = {
        type: "remote",
        description: "Test remote agent",
        config: {
          protocol: "acp",
          endpoint: "https://example.com/agent",
          agent_name: "test-agent",
          default_mode: "async",
          health_check_interval: "30s",
          max_retries: 2,
        },
      };

      const result = builder.addAgent("remote-agent", agentConfig);
      assertEquals(result.success, true);
      assertEquals(result.errors.length, 0);
    });

    it("should prevent duplicate agent IDs", () => {
      const builder = createInitializedBuilder();
      const agentConfig: WorkspaceAgentConfig = {
        type: "llm",
        description: "Test agent",
        config: {
          provider: "anthropic",
          model: "claude-3-5-sonnet-latest",
          prompt: "Test prompt",
          temperature: 0.3,
        },
      };

      builder.addAgent("duplicate-agent", agentConfig);
      const result = builder.addAgent("duplicate-agent", agentConfig);

      assertEquals(result.success, false);
      assertEquals(result.errors.length > 0, true);
      assertStringIncludes(result.errors[0]!, "already exists");
    });
  });

  describe("Job management", () => {
    function createJobTestBuilder(): WorkspaceBuilder {
      const builder = createBuilder();
      builder.initialize({ name: "test-workspace", description: "Test workspace" });

      // Add required signal and agent
      builder.addSignal("test-signal", {
        provider: "schedule",
        description: "Test signal",
        config: { schedule: "0 * * * *", timezone: "UTC" },
      });

      builder.addAgent("test-agent", {
        type: "llm",
        description: "Test agent",
        config: {
          provider: "anthropic",
          model: "claude-3-5-sonnet-latest",
          prompt: "Test prompt",
          temperature: 0.3,
        },
      });
      return builder;
    }

    it("should add valid job with signal and agent references", () => {
      const builder = createJobTestBuilder();
      const jobConfig: JobSpecification = {
        description: "Test job",
        triggers: [{ signal: "test-signal" }],
        execution: {
          strategy: "sequential",
          agents: ["test-agent"],
        },
      };

      const result = builder.addJob("test-job", jobConfig);
      assertEquals(result.success, true);
      assertEquals(result.errors.length, 0);
    });

    it("should validate signal references in job triggers", () => {
      const builder = createJobTestBuilder();
      const jobConfig: JobSpecification = {
        description: "Test job with invalid signal",
        triggers: [{ signal: "nonexistent-signal" }],
        execution: {
          strategy: "sequential",
          agents: ["test-agent"],
        },
      };

      const result = builder.addJob("invalid-job", jobConfig);
      assertEquals(result.success, false);
      assertEquals(result.errors.length > 0, true);
      assertStringIncludes(result.errors[0]!, "undefined signal");
    });

    it("should validate agent references in job execution", () => {
      const builder = createJobTestBuilder();
      const jobConfig: JobSpecification = {
        description: "Test job with invalid agent",
        triggers: [{ signal: "test-signal" }],
        execution: {
          strategy: "sequential",
          agents: ["nonexistent-agent"],
        },
      };

      const result = builder.addJob("invalid-job", jobConfig);
      assertEquals(result.success, false);
      assertEquals(result.errors.length > 0, true);
      assertStringIncludes(result.errors[0]!, "undefined agent");
    });

    it("should prevent duplicate job names", () => {
      const builder = createJobTestBuilder();
      const jobConfig: JobSpecification = {
        description: "Test job",
        triggers: [{ signal: "test-signal" }],
        execution: {
          strategy: "sequential",
          agents: ["test-agent"],
        },
      };

      builder.addJob("duplicate-job", jobConfig);
      const result = builder.addJob("duplicate-job", jobConfig);

      assertEquals(result.success, false);
      assertEquals(result.errors.length > 0, true);
      assertStringIncludes(result.errors[0]!, "already exists");
    });
  });

  describe("MCP integration management", () => {
    function createInitializedBuilder(): WorkspaceBuilder {
      const builder = createBuilder();
      builder.initialize({ name: "test-workspace", description: "Test workspace" });
      return builder;
    }

    it("should add valid MCP server integration", () => {
      const builder = createInitializedBuilder();
      const mcpConfig: MCPServerConfig = {
        transport: {
          type: "stdio",
          command: "deno",
          args: ["run", "--allow-all", "server.ts"],
        },
        env: {
          TEST_VAR: "test-value",
        },
      };

      const result = builder.addMCPIntegration("test-server", mcpConfig);
      assertEquals(result.success, true);
      assertEquals(result.errors.length, 0);
    });

    it("should prevent duplicate MCP server names", () => {
      const builder = createInitializedBuilder();
      const mcpConfig: MCPServerConfig = {
        transport: {
          type: "stdio",
          command: "deno",
          args: ["run", "server.ts"],
        },
      };

      builder.addMCPIntegration("duplicate-server", mcpConfig);
      const result = builder.addMCPIntegration("duplicate-server", mcpConfig);

      assertEquals(result.success, false);
      assertEquals(result.errors.length > 0, true);
      assertStringIncludes(result.errors[0]!, "already exists");
    });
  });

  describe("Workspace validation", () => {
    it("should validate complete workspace configuration", () => {
      const builder = createBuilder();
      builder.initialize({ name: "complete-workspace", description: "Complete test workspace" });

      builder.addSignal("schedule-signal", {
        provider: "schedule",
        description: "Scheduled trigger",
        config: { schedule: "0 9 * * *", timezone: "UTC" },
      });

      builder.addAgent("llm-agent", {
        type: "llm",
        description: "LLM processor",
        config: {
          provider: "anthropic",
          model: "claude-3-5-sonnet-latest",
          prompt: "Process the input",
          temperature: 0.3,
        },
      });

      builder.addJob("processing-job", {
        description: "Process scheduled data",
        triggers: [{ signal: "schedule-signal" }],
        execution: {
          strategy: "sequential",
          agents: ["llm-agent"],
        },
      });

      const result = builder.validateWorkspace();
      assertEquals(result.success, true);
      assertEquals(result.errors.length, 0);
    });

    it("should fail validation without workspace identity", () => {
      const builder = createBuilder();
      const result = builder.validateWorkspace();
      assertEquals(result.success, false);
      assertEquals(result.errors.length > 0, true);
      assertStringIncludes(result.errors[0]!, "not initialized");
    });
  });

  describe("Configuration export", () => {
    it("should export valid workspace configuration", () => {
      const builder = createBuilder();
      builder.initialize({ name: "export-test", description: "Export test workspace" });

      builder.addSignal("test-signal", {
        provider: "schedule",
        description: "Test signal",
        config: { schedule: "0 * * * *", timezone: "UTC" },
      });

      const config = builder.exportConfig();

      assertEquals(config.version, "1.0");
      assertEquals(config.workspace.name, "export-test");
      assertExists(config.signals);
      assertExists(config.signals["test-signal"]);
    });

    it("should include MCP tools section when servers exist", () => {
      const builder = createBuilder();
      builder.initialize({ name: "mcp-test", description: "MCP test workspace" });

      builder.addMCPIntegration("test-server", {
        transport: {
          type: "stdio",
          command: "deno",
          args: ["run", "server.ts"],
        },
      });

      const config = builder.exportConfig();

      assertExists(config.tools);
      assertExists(config.tools?.mcp);
      assertExists(config.tools?.mcp?.servers);
      assertExists(config.tools?.mcp?.servers["test-server"]);
    });
  });

  describe("State reset", () => {
    it("should reset all builder state", () => {
      const builder = createBuilder();
      builder.initialize({ name: "reset-test", description: "Reset test" });

      builder.addSignal("test-signal", {
        provider: "schedule",
        description: "Test signal",
        config: { schedule: "0 * * * *", timezone: "UTC" },
      });

      builder.reset();

      const result = builder.validateWorkspace();
      assertEquals(result.success, false);
      assertEquals(result.errors.length > 0, true);
      assertStringIncludes(result.errors[0]!, "not initialized");
    });
  });
});
