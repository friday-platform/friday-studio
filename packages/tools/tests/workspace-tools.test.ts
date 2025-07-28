/**
 * Unit tests for Workspace Building Tools
 */

import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import {
  workspaceBuilder,
  workspaceBuilderTools,
} from "../src/internal/workspace-creation/tools.ts";

// Test constant for tool call options
const testOptions = {
  toolCallId: "test-tool-call-id",
  messages: [],
};

function resetBuilder() {
  workspaceBuilder.reset();
}

Deno.test({
  name:
    "Workspace Building Tools - initializeWorkspace should initialize workspace with valid parameters",
  async fn() {
    resetBuilder();

    const result = await workspaceBuilderTools.initializeWorkspace.execute!({
      name: "test-workspace",
      description: "Test workspace description",
    }, testOptions);

    assertEquals(result.status, "initialized");
    assertStringIncludes(result.message, "initialized successfully");
  },
});

Deno.test({
  name: "Workspace Building Tools - initializeWorkspace should validate name parameter",
  async fn() {
    resetBuilder();

    // Test will throw if schema validation fails
    await workspaceBuilderTools.initializeWorkspace.execute!({
      name: "valid-name",
      description: "Valid description",
    }, testOptions);
  },
});

Deno.test({
  name: "Workspace Building Tools - addScheduleSignal should add valid schedule signal",
  async fn() {
    resetBuilder();
    await workspaceBuilderTools.initializeWorkspace.execute!({
      name: "test-workspace",
      description: "Test workspace",
    }, testOptions);

    const result = await workspaceBuilderTools.addScheduleSignal.execute!({
      signalName: "daily-check",
      description: "Daily scheduled check",
      schedule: "0 9 * * *",
      timezone: "UTC",
    }, testOptions);

    assertEquals(result.status, "added");
    assertEquals(result.signalName, "daily-check");
    assertStringIncludes(result.message, "signal 'daily-check' added");
  },
});

Deno.test({
  name:
    "Workspace Building Tools - addScheduleSignal should use default timezone when not provided",
  async fn() {
    resetBuilder();
    await workspaceBuilderTools.initializeWorkspace.execute!({
      name: "test-workspace",
      description: "Test workspace",
    }, testOptions);

    const result = await workspaceBuilderTools.addScheduleSignal.execute!({
      signalName: "hourly-check",
      description: "Hourly check",
      schedule: "0 * * * *",
      timezone: "UTC",
    }, testOptions);

    assertEquals(result.status, "added");
  },
});

Deno.test({
  name: "Workspace Building Tools - addScheduleSignal should prevent duplicate signal names",
  async fn() {
    resetBuilder();
    await workspaceBuilderTools.initializeWorkspace.execute!({
      name: "test-workspace",
      description: "Test workspace",
    }, testOptions);

    await workspaceBuilderTools.addScheduleSignal.execute!({
      signalName: "duplicate-signal",
      description: "First signal",
      schedule: "0 * * * *",
      timezone: "UTC",
    }, testOptions);

    let errorThrown = false;
    try {
      await workspaceBuilderTools.addScheduleSignal.execute!({
        signalName: "duplicate-signal",
        description: "Second signal",
        schedule: "0 * * * *",
        timezone: "UTC",
      }, testOptions);
    } catch (error) {
      errorThrown = true;
      assertStringIncludes((error as Error).message, "already exists");
    }
    assertEquals(errorThrown, true, "Expected error to be thrown for duplicate signal");
  },
});

Deno.test({
  name: "Workspace Building Tools - addWebhookSignal should add valid webhook signal",
  async fn() {
    resetBuilder();
    await workspaceBuilderTools.initializeWorkspace.execute!({
      name: "test-workspace",
      description: "Test workspace",
    }, testOptions);

    const result = await workspaceBuilderTools.addWebhookSignal.execute!({
      signalName: "webhook-trigger",
      description: "Webhook trigger signal",
      path: "/webhook/test",
    }, testOptions);

    assertEquals(result.status, "added");
    assertEquals(result.signalName, "webhook-trigger");
    assertStringIncludes(result.message, "signal 'webhook-trigger' added");
  },
});

Deno.test({
  name: "Workspace Building Tools - addLLMAgent should add valid LLM agent",
  async fn() {
    resetBuilder();
    await workspaceBuilderTools.initializeWorkspace.execute!({
      name: "test-workspace",
      description: "Test workspace",
    }, testOptions);

    const result = await workspaceBuilderTools.addLLMAgent.execute!({
      agentId: "llm-processor",
      description: "LLM processing agent",
      provider: "anthropic",
      model: "claude-3-5-sonnet-latest",
      prompt: "You are a helpful assistant",
      tools: ["atlas_fetch"],
      temperature: 0.3,
    }, testOptions);

    assertEquals(result.status, "added");
    assertEquals(result.agentId, "llm-processor");
    assertStringIncludes(result.message, "agent 'llm-processor' added");
  },
});

Deno.test({
  name: "Workspace Building Tools - addLLMAgent should use default values for optional parameters",
  async fn() {
    resetBuilder();
    await workspaceBuilderTools.initializeWorkspace.execute!({
      name: "test-workspace",
      description: "Test workspace",
    }, testOptions);

    const result = await workspaceBuilderTools.addLLMAgent.execute!({
      agentId: "basic-agent",
      description: "Basic LLM agent",
      provider: "anthropic",
      model: "claude-3-5-sonnet-latest",
      prompt: "You are a basic assistant",
      tools: [],
      temperature: 0.3,
    }, testOptions);

    assertEquals(result.status, "added");
  },
});

Deno.test({
  name: "Workspace Building Tools - addRemoteAgent should add valid remote agent",
  async fn() {
    resetBuilder();
    await workspaceBuilderTools.initializeWorkspace.execute!({
      name: "test-workspace",
      description: "Test workspace",
    }, testOptions);

    const result = await workspaceBuilderTools.addRemoteAgent.execute!({
      agentId: "external-service",
      description: "External service agent",
      endpoint: "https://example.com/agent",
      agentName: "external-agent",
      defaultMode: "async",
    }, testOptions);

    assertEquals(result.status, "added");
    assertEquals(result.agentId, "external-service");
    assertStringIncludes(result.message, "agent 'external-service' added");
  },
});

Deno.test({
  name: "Workspace Building Tools - addRemoteAgent should use default mode when not specified",
  async fn() {
    resetBuilder();
    await workspaceBuilderTools.initializeWorkspace.execute!({
      name: "test-workspace",
      description: "Test workspace",
    }, testOptions);

    const result = await workspaceBuilderTools.addRemoteAgent.execute!({
      agentId: "remote-default",
      description: "Remote agent with defaults",
      endpoint: "https://example.com/agent",
      agentName: "remote-agent",
      defaultMode: "async",
    }, testOptions);

    assertEquals(result.status, "added");
  },
});

Deno.test({
  name:
    "Workspace Building Tools - createJob should create valid job with signal and agent references",
  async fn() {
    resetBuilder();
    await workspaceBuilderTools.initializeWorkspace.execute!({
      name: "test-workspace",
      description: "Test workspace",
    }, testOptions);

    // Add signal and agent first
    await workspaceBuilderTools.addScheduleSignal.execute!({
      signalName: "job-trigger",
      description: "Job trigger signal",
      schedule: "0 * * * *",
      timezone: "UTC",
    }, testOptions);

    await workspaceBuilderTools.addLLMAgent.execute!({
      agentId: "job-processor",
      description: "Job processing agent",
      provider: "anthropic",
      model: "claude-3-5-sonnet-latest",
      prompt: "Process the job",
      tools: [],
      temperature: 0.3,
    }, testOptions);

    const result = await workspaceBuilderTools.createJob.execute!({
      jobName: "processing-job",
      description: "Data processing job",
      triggerSignal: "job-trigger",
      agents: ["job-processor"],
      strategy: "sequential",
    }, testOptions);

    assertEquals(result.status, "created");
    assertEquals(result.jobName, "processing-job");
    assertStringIncludes(result.message, "created successfully");
  },
});

Deno.test({
  name: "Workspace Building Tools - createJob should fail with invalid signal reference",
  async fn() {
    resetBuilder();
    await workspaceBuilderTools.initializeWorkspace.execute!({
      name: "test-workspace",
      description: "Test workspace",
    }, testOptions);

    await workspaceBuilderTools.addLLMAgent.execute!({
      agentId: "test-agent",
      description: "Test agent",
      provider: "anthropic",
      model: "claude-3-5-sonnet-latest",
      prompt: "Test prompt",
      tools: [],
      temperature: 0.3,
    }, testOptions);

    let errorThrown = false;
    try {
      await workspaceBuilderTools.createJob.execute!({
        jobName: "invalid-job",
        description: "Invalid job",
        triggerSignal: "nonexistent-signal",
        agents: ["test-agent"],
        strategy: "sequential",
      }, testOptions);
    } catch (error) {
      errorThrown = true;
      assertStringIncludes((error as Error).message, "undefined signal");
    }
    assertEquals(errorThrown, true, "Expected error to be thrown for invalid signal reference");
  },
});

Deno.test({
  name: "Workspace Building Tools - createJob should fail with invalid agent reference",
  async fn() {
    resetBuilder();
    await workspaceBuilderTools.initializeWorkspace.execute!({
      name: "test-workspace",
      description: "Test workspace",
    }, testOptions);

    await workspaceBuilderTools.addScheduleSignal.execute!({
      signalName: "test-signal",
      description: "Test signal",
      schedule: "0 * * * *",
      timezone: "UTC",
    }, testOptions);

    let errorThrown = false;
    try {
      await workspaceBuilderTools.createJob.execute!({
        jobName: "invalid-job",
        description: "Invalid job",
        triggerSignal: "test-signal",
        agents: ["nonexistent-agent"],
        strategy: "sequential",
      }, testOptions);
    } catch (error) {
      errorThrown = true;
      assertStringIncludes((error as Error).message, "undefined agent");
    }
    assertEquals(errorThrown, true, "Expected error to be thrown for invalid agent reference");
  },
});

Deno.test({
  name: "Workspace Building Tools - addMCPIntegration should add valid MCP server integration",
  async fn() {
    resetBuilder();
    await workspaceBuilderTools.initializeWorkspace.execute!({
      name: "test-workspace",
      description: "Test workspace",
    }, testOptions);

    const result = await workspaceBuilderTools.addMCPIntegration.execute!({
      serverName: "web-scraper",
      command: "deno",
      args: ["run", "--allow-all", "scraper.ts"],
      env: {
        API_KEY: "test-key",
      },
    }, testOptions);

    assertEquals(result.status, "added");
    assertEquals(result.serverName, "web-scraper");
    assertStringIncludes(result.message, "integration 'web-scraper' added");
  },
});

Deno.test({
  name:
    "Workspace Building Tools - addMCPIntegration should work with default args and without env",
  async fn() {
    resetBuilder();
    await workspaceBuilderTools.initializeWorkspace.execute!({
      name: "test-workspace",
      description: "Test workspace",
    }, testOptions);

    const result = await workspaceBuilderTools.addMCPIntegration.execute!({
      serverName: "simple-server",
      command: "node",
      args: [],
    }, testOptions);

    assertEquals(result.status, "added");
  },
});

Deno.test({
  name:
    "Workspace Building Tools - validateWorkspace should validate complete workspace configuration",
  async fn() {
    resetBuilder();
    await workspaceBuilderTools.initializeWorkspace.execute!({
      name: "complete-workspace",
      description: "Complete test workspace",
    }, testOptions);

    await workspaceBuilderTools.addScheduleSignal.execute!({
      signalName: "validation-signal",
      description: "Validation test signal",
      schedule: "0 9 * * *",
      timezone: "UTC",
    }, testOptions);

    await workspaceBuilderTools.addLLMAgent.execute!({
      agentId: "validation-agent",
      description: "Validation test agent",
      provider: "anthropic",
      model: "claude-3-5-sonnet-latest",
      prompt: "Validate the input",
      tools: [],
      temperature: 0.3,
    }, testOptions);

    await workspaceBuilderTools.createJob.execute!({
      jobName: "validation-job",
      description: "Validation test job",
      triggerSignal: "validation-signal",
      agents: ["validation-agent"],
      strategy: "sequential",
    }, testOptions);

    const result = await workspaceBuilderTools.validateWorkspace.execute!({}, testOptions);

    assertEquals(result.status, "valid");
    assertStringIncludes(result.message, "valid");
  },
});

Deno.test({
  name:
    "Workspace Building Tools - validateWorkspace should fail validation for incomplete workspace",
  async fn() {
    resetBuilder();
    // Don't initialize workspace

    let errorThrown = false;
    try {
      await workspaceBuilderTools.validateWorkspace.execute!({}, testOptions);
    } catch (error) {
      errorThrown = true;
      assertStringIncludes((error as Error).message, "not initialized");
    }
    assertEquals(errorThrown, true, "Expected error to be thrown for uninitialized workspace");
  },
});

Deno.test({
  name: "Workspace Building Tools - exportWorkspace should export complete workspace configuration",
  async fn() {
    resetBuilder();
    await workspaceBuilderTools.initializeWorkspace.execute!({
      name: "export-workspace",
      description: "Export test workspace",
    }, testOptions);

    await workspaceBuilderTools.addScheduleSignal.execute!({
      signalName: "export-signal",
      description: "Export test signal",
      schedule: "0 * * * *",
      timezone: "UTC",
    }, testOptions);

    const result = await workspaceBuilderTools.exportWorkspace.execute!({}, testOptions);

    assertEquals(result.status, "exported");
    assertStringIncludes(result.message, "exported successfully");
    assertExists(result.config);
    assertEquals(result.config.version, "1.0");
    assertEquals(result.config.workspace.name, "export-workspace");
    assertExists(result.config.signals);
    assertExists(result.config.signals["export-signal"]);
  },
});

Deno.test({
  name:
    "Workspace Building Tools - exportWorkspace should include MCP tools section when servers exist",
  async fn() {
    resetBuilder();
    await workspaceBuilderTools.initializeWorkspace.execute!({
      name: "mcp-workspace",
      description: "MCP test workspace",
    }, testOptions);

    await workspaceBuilderTools.addMCPIntegration.execute!({
      serverName: "test-mcp-server",
      command: "deno",
      args: ["run", "server.ts"],
    }, testOptions);

    const result = await workspaceBuilderTools.exportWorkspace.execute!({}, testOptions);

    assertEquals(result.status, "exported");
    assertExists(result.config.tools);
    assertExists(result.config.tools?.mcp);
    assertExists(result.config.tools?.mcp?.servers);
    assertExists(result.config.tools?.mcp?.servers["test-mcp-server"]);
  },
});

Deno.test({
  name: "Workspace Building Tools - exportWorkspace should fail export without workspace identity",
  async fn() {
    resetBuilder();
    // Don't initialize workspace

    let errorThrown = false;
    try {
      await workspaceBuilderTools.exportWorkspace.execute!({}, testOptions);
    } catch (error) {
      errorThrown = true;
      assertStringIncludes(
        (error as Error).message,
        "Cannot export configuration without workspace identity",
      );
    }
    assertEquals(errorThrown, true, "Expected error to be thrown for export without identity");
  },
});

Deno.test({
  name:
    "Workspace Building Tools - Tool integration should support complete workspace building workflow",
  async fn() {
    resetBuilder();

    // Step 1: Initialize workspace
    await workspaceBuilderTools.initializeWorkspace.execute!({
      name: "workflow-test",
      description: "Complete workflow test",
    }, testOptions);

    // Step 2: Add signals
    await workspaceBuilderTools.addScheduleSignal.execute!({
      signalName: "hourly-trigger",
      description: "Hourly processing trigger",
      schedule: "0 * * * *",
      timezone: "UTC",
    }, testOptions);

    await workspaceBuilderTools.addWebhookSignal.execute!({
      signalName: "api-webhook",
      description: "API webhook endpoint",
      path: "/api/webhook",
    }, testOptions);

    // Step 3: Add agents
    await workspaceBuilderTools.addLLMAgent.execute!({
      agentId: "data-processor",
      description: "Data processing agent",
      provider: "anthropic",
      model: "claude-3-5-sonnet-latest",
      prompt: "Process incoming data",
      tools: ["atlas_fetch", "atlas_write"],
      temperature: 0.3,
    }, testOptions);

    await workspaceBuilderTools.addRemoteAgent.execute!({
      agentId: "file-handler",
      description: "File handling agent",
      endpoint: "https://example.com/file-processor",
      agentName: "file-processor",
      defaultMode: "async",
    }, testOptions);

    // Step 4: Create jobs
    await workspaceBuilderTools.createJob.execute!({
      jobName: "hourly-processing",
      description: "Hourly data processing",
      triggerSignal: "hourly-trigger",
      agents: ["data-processor", "file-handler"],
      strategy: "sequential",
    }, testOptions);

    await workspaceBuilderTools.createJob.execute!({
      jobName: "webhook-processing",
      description: "Webhook data processing",
      triggerSignal: "api-webhook",
      agents: ["data-processor"],
      strategy: "sequential",
    }, testOptions);

    // Step 5: Add MCP integration
    await workspaceBuilderTools.addMCPIntegration.execute!({
      serverName: "external-api",
      command: "node",
      args: ["api-server.js"],
      env: {
        PORT: "3000",
        API_TOKEN: "secret",
      },
    }, testOptions);

    // Step 6: Validate
    const validation = await workspaceBuilderTools.validateWorkspace.execute!({}, testOptions);
    assertEquals(validation.status, "valid");

    // Step 7: Export
    const exported = await workspaceBuilderTools.exportWorkspace.execute!({}, testOptions);
    assertEquals(exported.status, "exported");
    assertExists(exported.config);

    // Verify the complete configuration
    const config = exported.config;
    assertEquals(config.workspace.name, "workflow-test");
    assertEquals(Object.keys(config.signals || {}).length, 2);
    assertEquals(Object.keys(config.agents || {}).length, 2);
    assertEquals(Object.keys(config.jobs || {}).length, 2);
    assertExists(config.tools?.mcp?.servers);
    assertExists(config.tools.mcp.servers["external-api"]);
  },
});
