/**
 * Unit tests for WorkspaceBuilder class
 */

import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import type {
  JobSpecification,
  MCPServerConfig,
  WorkspaceAgentConfig,
  WorkspaceConfig,
  WorkspaceSignalConfig,
} from "@atlas/config";
import { WorkspaceBuilder } from "../src/internal/workspace-creation/builder.ts";

function createBuilder(): WorkspaceBuilder {
  return new WorkspaceBuilder();
}

// Identity initialization tests
Deno.test({
  name: "WorkspaceBuilder - Initialize workspace with valid identity",
  fn() {
    const builder = createBuilder();
    const result = builder.initialize({
      name: "test-workspace",
      description: "Test workspace description",
    });

    assertEquals(result.success, true);
    assertEquals(result.errors.length, 0);
  },
});

Deno.test({
  name: "WorkspaceBuilder - Require identity before exporting config",
  fn() {
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
  },
});

// Signal management tests
function createInitializedBuilder(): WorkspaceBuilder {
  const builder = createBuilder();
  builder.initialize({ name: "test-workspace", description: "Test workspace" });
  return builder;
}

Deno.test({
  name: "WorkspaceBuilder - Add valid schedule signal",
  fn() {
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
  },
});

Deno.test({
  name: "WorkspaceBuilder - Add valid HTTP signal",
  fn() {
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
  },
});

Deno.test({
  name: "WorkspaceBuilder - Prevent duplicate signal names",
  fn() {
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
  },
});

Deno.test({
  name: "WorkspaceBuilder - Validate signal configuration schema",
  fn() {
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
  },
});

// Agent management tests
Deno.test({
  name: "WorkspaceBuilder - Add valid LLM agent",
  fn() {
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
  },
});

Deno.test({
  name: "WorkspaceBuilder - Add valid remote agent",
  fn() {
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
  },
});

Deno.test({
  name: "WorkspaceBuilder - Prevent duplicate agent IDs",
  fn() {
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
  },
});

// Job management tests
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

Deno.test({
  name: "WorkspaceBuilder - Add valid job with signal and agent references",
  fn() {
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
  },
});

Deno.test({
  name: "WorkspaceBuilder - Validate signal references in job triggers",
  fn() {
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
  },
});

Deno.test({
  name: "WorkspaceBuilder - Validate agent references in job execution",
  fn() {
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
  },
});

Deno.test({
  name: "WorkspaceBuilder - Prevent duplicate job names",
  fn() {
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
  },
});

// MCP integration management tests
Deno.test({
  name: "WorkspaceBuilder - Add valid MCP server integration",
  fn() {
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
  },
});

Deno.test({
  name: "WorkspaceBuilder - Prevent duplicate MCP server names",
  fn() {
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
  },
});

// Workspace validation tests
Deno.test({
  name: "WorkspaceBuilder - Validate complete workspace configuration",
  fn() {
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
  },
});

Deno.test({
  name: "WorkspaceBuilder - Fail validation without workspace identity",
  fn() {
    const builder = createBuilder();
    const result = builder.validateWorkspace();
    assertEquals(result.success, false);
    assertEquals(result.errors.length > 0, true);
    assertStringIncludes(result.errors[0]!, "not initialized");
  },
});

// Configuration export tests
Deno.test({
  name: "WorkspaceBuilder - Export valid workspace configuration",
  fn() {
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
  },
});

Deno.test({
  name: "WorkspaceBuilder - Include MCP tools section when servers exist",
  fn() {
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
  },
});

// State reset tests
Deno.test({
  name: "WorkspaceBuilder - Reset all builder state",
  fn() {
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
  },
});

// Constructor with existing configuration tests
function createExistingConfig(): WorkspaceConfig {
  return {
    version: "1.0",
    workspace: {
      name: "existing-workspace",
      description: "Existing workspace for testing",
    },
    signals: {
      "existing-signal": {
        provider: "schedule",
        description: "Existing schedule signal",
        config: {
          schedule: "0 9 * * *",
          timezone: "UTC",
        },
      },
    },
    agents: {
      "existing-agent": {
        type: "llm",
        description: "Existing LLM agent",
        config: {
          provider: "anthropic",
          model: "claude-3-5-sonnet-latest",
          prompt: "Existing agent prompt",
          temperature: 0.3,
        },
      },
    },
    jobs: {
      "existing-job": {
        description: "Existing job",
        triggers: [{ signal: "existing-signal" }],
        execution: {
          strategy: "sequential",
          agents: ["existing-agent"],
        },
      },
    },
    tools: {
      mcp: {
        client_config: { timeout: "30s" },
        servers: {
          "existing-server": {
            transport: {
              type: "stdio",
              command: "deno",
              args: ["run", "server.ts"],
            },
          },
        },
      },
    },
  };
}

Deno.test({
  name: "WorkspaceBuilder - Initialize from existing workspace configuration",
  fn() {
    const existingConfig = createExistingConfig();
    const builder = new WorkspaceBuilder(existingConfig);

    const result = builder.validateWorkspace();
    assertEquals(result.success, true);
    assertEquals(result.errors.length, 0);
  },
});

Deno.test({
  name: "WorkspaceBuilder - Preserve existing configuration when exporting",
  fn() {
    const existingConfig = createExistingConfig();
    const builder = new WorkspaceBuilder(existingConfig);

    const exportedConfig = builder.exportConfig();

    assertEquals(exportedConfig.workspace.name, "existing-workspace");
    assertEquals(exportedConfig.workspace.description, "Existing workspace for testing");
    assertExists(exportedConfig.signals!["existing-signal"]);
    assertExists(exportedConfig.agents!["existing-agent"]);
    assertExists(exportedConfig.jobs!["existing-job"]);
    assertExists(exportedConfig.tools?.mcp?.servers!["existing-server"]);
  },
});

Deno.test({
  name: "WorkspaceBuilder - Handle workspace configuration without description",
  fn() {
    const configWithoutDescription: WorkspaceConfig = {
      version: "1.0",
      workspace: {
        name: "no-description-workspace",
      },
      signals: {},
      agents: {},
      jobs: {},
    };

    const builder = new WorkspaceBuilder(configWithoutDescription);
    const exportedConfig = builder.exportConfig();

    assertEquals(exportedConfig.workspace.name, "no-description-workspace");
    assertEquals(exportedConfig.workspace.description, "");
  },
});

Deno.test({
  name: "WorkspaceBuilder - Handle minimal workspace configuration",
  fn() {
    const minimalConfig: WorkspaceConfig = {
      version: "1.0",
      workspace: {
        name: "minimal-workspace",
        description: "Minimal config",
      },
      signals: {},
      agents: {},
      jobs: {},
    };

    const builder = new WorkspaceBuilder(minimalConfig);
    const result = builder.validateWorkspace();

    assertEquals(result.success, true);
    assertEquals(result.errors.length, 0);
  },
});

// Component update operations tests
function createBuilderWithComponents(): WorkspaceBuilder {
  const builder = new WorkspaceBuilder();
  builder.initialize({ name: "update-test", description: "Update test workspace" });

  builder.addSignal("test-signal", {
    provider: "schedule",
    description: "Original signal",
    config: { schedule: "0 * * * *", timezone: "UTC" },
  });

  builder.addAgent("test-agent", {
    type: "llm",
    description: "Original agent",
    config: {
      provider: "anthropic",
      model: "claude-3-5-sonnet-latest",
      prompt: "Original prompt",
      temperature: 0.3,
    },
  });

  builder.addJob("test-job", {
    description: "Original job",
    triggers: [{ signal: "test-signal" }],
    execution: {
      strategy: "sequential",
      agents: ["test-agent"],
    },
  });

  return builder;
}

// Signal update tests
Deno.test({
  name: "WorkspaceBuilder - Update existing signal configuration",
  fn() {
    const builder = createBuilderWithComponents();

    const result = builder.updateSignal("test-signal", {
      description: "Updated signal description",
      config: { schedule: "0 9 * * *", timezone: "America/New_York" },
    });

    assertEquals(result.success, true);
    assertEquals(result.errors.length, 0);

    const config = builder.exportConfig();
    assertEquals(config.signals!["test-signal"]?.description, "Updated signal description");
    assertEquals(config.signals!["test-signal"]?.config.schedule, "0 9 * * *");
    assertEquals(config.signals!["test-signal"]?.config.timezone, "America/New_York");
  },
});

Deno.test({
  name: "WorkspaceBuilder - Fail to update nonexistent signal",
  fn() {
    const builder = createBuilderWithComponents();

    const result = builder.updateSignal("nonexistent-signal", {
      description: "Updated description",
    });

    assertEquals(result.success, false);
    assertEquals(result.errors.length > 0, true);
    assertStringIncludes(result.errors[0]!, "does not exist");
  },
});

Deno.test({
  name: "WorkspaceBuilder - Validate signal updates against schema",
  fn() {
    const builder = createBuilderWithComponents();

    const result = builder.updateSignal("test-signal", {
      // @ts-expect-error Testing invalid config for validation
      provider: "invalid-provider",
    });

    assertEquals(result.success, false);
    assertEquals(result.errors.length > 0, true);
  },
});

// Agent update tests
Deno.test({
  name: "WorkspaceBuilder - Update existing agent configuration",
  fn() {
    const builder = createBuilderWithComponents();

    const result = builder.updateAgent("test-agent", {
      description: "Updated agent description",
    });

    assertEquals(result.success, true);
    assertEquals(result.errors.length, 0);

    const config = builder.exportConfig();
    assertEquals(config.agents!["test-agent"]?.description, "Updated agent description");
  },
});

Deno.test({
  name: "WorkspaceBuilder - Fail to update nonexistent agent",
  fn() {
    const builder = createBuilderWithComponents();

    const result = builder.updateAgent("nonexistent-agent", {
      description: "Updated description",
    });

    assertEquals(result.success, false);
    assertEquals(result.errors.length > 0, true);
    assertStringIncludes(result.errors[0]!, "does not exist");
  },
});

// Job update tests
Deno.test({
  name: "WorkspaceBuilder - Update existing job configuration",
  fn() {
    const builder = createBuilderWithComponents();

    const result = builder.updateJob("test-job", {
      description: "Updated job description",
      execution: {
        strategy: "parallel",
        agents: ["test-agent"],
      },
    });

    assertEquals(result.success, true);
    assertEquals(result.errors.length, 0);

    const config = builder.exportConfig();
    assertEquals(config.jobs!["test-job"]?.description, "Updated job description");
    assertEquals(config.jobs!["test-job"]?.execution?.strategy, "parallel");
  },
});

Deno.test({
  name: "WorkspaceBuilder - Fail to update nonexistent job",
  fn() {
    const builder = createBuilderWithComponents();

    const result = builder.updateJob("nonexistent-job", {
      description: "Updated description",
    });

    assertEquals(result.success, false);
    assertEquals(result.errors.length > 0, true);
    assertStringIncludes(result.errors[0]!, "does not exist");
  },
});

Deno.test({
  name: "WorkspaceBuilder - Validate signal references in job updates",
  fn() {
    const builder = createBuilderWithComponents();

    const result = builder.updateJob("test-job", {
      triggers: [{ signal: "nonexistent-signal" }],
    });

    assertEquals(result.success, false);
    assertEquals(result.errors.length > 0, true);
    assertStringIncludes(result.errors[0]!, "undefined signal");
  },
});

Deno.test({
  name: "WorkspaceBuilder - Validate agent references in job updates",
  fn() {
    const builder = createBuilderWithComponents();

    const result = builder.updateJob("test-job", {
      execution: {
        strategy: "sequential",
        agents: ["nonexistent-agent"],
      },
    });

    assertEquals(result.success, false);
    assertEquals(result.errors.length > 0, true);
    assertStringIncludes(result.errors[0]!, "undefined agent");
  },
});

// Component removal operations tests
function createBuilderWithRemovalComponents(): WorkspaceBuilder {
  const builder = new WorkspaceBuilder();
  builder.initialize({ name: "removal-test", description: "Removal test workspace" });

  builder.addSignal("test-signal", {
    provider: "schedule",
    description: "Test signal",
    config: { schedule: "0 * * * *", timezone: "UTC" },
  });

  builder.addSignal("unused-signal", {
    provider: "schedule",
    description: "Unused signal",
    config: { schedule: "0 2 * * *", timezone: "UTC" },
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

  builder.addAgent("unused-agent", {
    type: "llm",
    description: "Unused agent",
    config: {
      provider: "anthropic",
      model: "claude-3-5-sonnet-latest",
      prompt: "Unused prompt",
      temperature: 0.3,
    },
  });

  builder.addJob("test-job", {
    description: "Test job",
    triggers: [{ signal: "test-signal" }],
    execution: {
      strategy: "sequential",
      agents: ["test-agent"],
    },
  });

  return builder;
}

// Signal removal tests
Deno.test({
  name: "WorkspaceBuilder - Remove unused signal successfully",
  fn() {
    const builder = createBuilderWithRemovalComponents();

    const result = builder.removeSignal("unused-signal");

    assertEquals(result.success, true);
    assertEquals(result.errors.length, 0);

    const config = builder.exportConfig();
    assertEquals(config.signals!["unused-signal"], undefined);
    assertExists(config.signals!["test-signal"]);
  },
});

Deno.test({
  name: "WorkspaceBuilder - Prevent removal of signal referenced by jobs",
  fn() {
    const builder = createBuilderWithRemovalComponents();

    const result = builder.removeSignal("test-signal");

    assertEquals(result.success, false);
    assertEquals(result.errors.length > 0, true);
    assertStringIncludes(result.errors[0]!, "referenced by jobs");
  },
});

Deno.test({
  name: "WorkspaceBuilder - Fail to remove nonexistent signal",
  fn() {
    const builder = createBuilderWithRemovalComponents();

    const result = builder.removeSignal("nonexistent-signal");

    assertEquals(result.success, false);
    assertEquals(result.errors.length > 0, true);
    assertStringIncludes(result.errors[0]!, "does not exist");
  },
});

// Agent removal tests
Deno.test({
  name: "WorkspaceBuilder - Remove unused agent successfully",
  fn() {
    const builder = createBuilderWithRemovalComponents();

    const result = builder.removeAgent("unused-agent");

    assertEquals(result.success, true);
    assertEquals(result.errors.length, 0);

    const config = builder.exportConfig();
    assertEquals(config.agents!["unused-agent"], undefined);
    assertExists(config.agents!["test-agent"]);
  },
});

Deno.test({
  name: "WorkspaceBuilder - Prevent removal of agent referenced by jobs",
  fn() {
    const builder = createBuilderWithRemovalComponents();

    const result = builder.removeAgent("test-agent");

    assertEquals(result.success, false);
    assertEquals(result.errors.length > 0, true);
    assertStringIncludes(result.errors[0]!, "referenced by jobs");
  },
});

Deno.test({
  name: "WorkspaceBuilder - Fail to remove nonexistent agent",
  fn() {
    const builder = createBuilderWithRemovalComponents();

    const result = builder.removeAgent("nonexistent-agent");

    assertEquals(result.success, false);
    assertEquals(result.errors.length > 0, true);
    assertStringIncludes(result.errors[0]!, "does not exist");
  },
});

// Job removal tests
Deno.test({
  name: "WorkspaceBuilder - Remove job successfully",
  fn() {
    const builder = createBuilderWithRemovalComponents();

    const result = builder.removeJob("test-job");

    assertEquals(result.success, true);
    assertEquals(result.errors.length, 0);

    const config = builder.exportConfig();
    assertEquals(config.jobs!["test-job"], undefined);
  },
});

Deno.test({
  name: "WorkspaceBuilder - Fail to remove nonexistent job",
  fn() {
    const builder = createBuilderWithRemovalComponents();

    const result = builder.removeJob("nonexistent-job");

    assertEquals(result.success, false);
    assertEquals(result.errors.length > 0, true);
    assertStringIncludes(result.errors[0]!, "does not exist");
  },
});

// Reference integrity validation tests
function createBuilderWithBrokenReferences(): WorkspaceBuilder {
  // Create a workspace with broken references by directly manipulating the internal state
  const existingConfig: WorkspaceConfig = {
    version: "1.0",
    workspace: {
      name: "broken-refs",
      description: "Broken references test",
    },
    signals: {}, // No signals defined
    agents: {}, // No agents defined
    jobs: {
      "job-with-broken-refs": {
        description: "Job that references nonexistent components",
        triggers: [{ signal: "nonexistent-signal" }],
        execution: {
          strategy: "sequential",
          agents: ["nonexistent-agent"],
        },
      },
    },
  };

  return new WorkspaceBuilder(existingConfig);
}

Deno.test({
  name: "WorkspaceBuilder - Detect broken signal references",
  fn() {
    const builder = createBuilderWithBrokenReferences();

    const result = builder.validateReferences();

    assertEquals(result.success, false);
    assertEquals(result.errors.length > 0, true);
    const hasSignalError = result.errors.some((error) => error.includes("undefined signal"));
    assertEquals(hasSignalError, true);
  },
});

Deno.test({
  name: "WorkspaceBuilder - Detect broken agent references",
  fn() {
    const builder = createBuilderWithBrokenReferences();

    const result = builder.validateReferences();

    assertEquals(result.success, false);
    assertEquals(result.errors.length > 0, true);
    const hasAgentError = result.errors.some((error) => error.includes("undefined agent"));
    assertEquals(hasAgentError, true);
  },
});

Deno.test({
  name: "WorkspaceBuilder - Repair broken references automatically",
  fn() {
    const builder = createBuilderWithBrokenReferences();

    // Confirm references are broken first
    const validationResult = builder.validateReferences();
    assertEquals(validationResult.success, false);

    // Repair broken references
    const repairResult = builder.repairBrokenReferences();

    assertEquals(repairResult.success, true);
    assertEquals(repairResult.repairs.length > 0, true);

    // Verify references are now valid (job should be removed entirely)
    const postRepairValidation = builder.validateReferences();
    assertEquals(postRepairValidation.success, true);
    assertEquals(postRepairValidation.errors.length, 0);
  },
});

Deno.test({
  name: "WorkspaceBuilder - Provide detailed repair information",
  fn() {
    const builder = createBuilderWithBrokenReferences();

    const repairResult = builder.repairBrokenReferences();

    assertEquals(repairResult.success, true);
    assertEquals(repairResult.repairs.length >= 2, true); // At least signal and job removal repair

    const hasSignalRepair = repairResult.repairs.some((repair) =>
      repair.includes("broken signal reference")
    );
    const hasJobRemoval = repairResult.repairs.some((repair) =>
      repair.includes("Removed job") && repair.includes("due to no valid")
    );

    assertEquals(hasSignalRepair, true);
    assertEquals(hasJobRemoval, true);
  },
});

Deno.test({
  name: "WorkspaceBuilder - Validate references as part of workspace validation",
  fn() {
    const builder = createBuilderWithBrokenReferences();

    const result = builder.validateWorkspace();

    assertEquals(result.success, false);
    assertEquals(result.errors.length > 0, true);
  },
});
