/**
 * Integration tests for architectural fixes
 * Tests that verify the major architectural changes work correctly
 */

import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { ConfigLoader } from "@atlas/config";
import { FilesystemConfigAdapter } from "@atlas/storage";
import { SessionSupervisorActor } from "../../src/core/actors/session-supervisor-actor.ts";
import type { AtlasMemoryConfig } from "../../src/core/memory-config.ts";

const testMemoryConfig: AtlasMemoryConfig = {
  default: {
    enabled: true,
    storage: "memory",
    cognitive_loop: false,
    retention: {
      max_age_days: 30,
      max_entries: 1000,
      cleanup_interval_hours: 24,
    },
  },
  agent: {
    enabled: true,
    scope: "agent",
    include_in_context: true,
    context_limits: {
      relevant_memories: 50,
      past_successes: 25,
      past_failures: 25,
    },
    memory_types: {},
  },
  session: {
    enabled: true,
    scope: "session",
    include_in_context: true,
    context_limits: {
      relevant_memories: 100,
      past_successes: 50,
      past_failures: 50,
    },
    memory_types: {},
  },
  workspace: {
    enabled: true,
    scope: "workspace",
    include_in_context: true,
    context_limits: {
      relevant_memories: 200,
      past_successes: 100,
      past_failures: 100,
    },
    memory_types: {},
  },
  streaming: {
    enabled: false,
    queue_max_size: 1000,
    batch_size: 10,
    flush_interval_ms: 5000,
    background_processing: false,
    persistence_enabled: false,
    error_retry_attempts: 3,
    priority_processing: false,
    dual_write_enabled: false,
    legacy_batch_enabled: false,
    stream_everything: false,
    performance_tracking: false,
  },
};

Deno.test("ConfigLoader - loads supervisor defaults from supervisor-defaults.yml", async () => {
  // Create minimal test workspace.yml
  const testWorkspaceConfig = `version: "1.0"
workspace:
  id: "550e8400-e29b-41d4-a716-446655440000"
  name: "Test Workspace"
  description: "Test workspace"
signals:
  test-signal:
    provider: "http"
    description: "Test signal"
agents:
  test-agent:
    type: "llm"
    model: "claude-3-5-sonnet-20241022"
    purpose: "Test agent"
`;

  await Deno.writeTextFile("workspace.yml", testWorkspaceConfig);

  try {
    const adapter = new FilesystemConfigAdapter();
    const configLoader = new ConfigLoader(adapter);
    const mergedConfig = await configLoader.load();

    // Verify supervisor defaults were loaded
    assertExists(mergedConfig.supervisorDefaults, "supervisorDefaults should be loaded");
    assertExists(mergedConfig.supervisorDefaults.supervisors, "supervisors config should exist");
    assertExists(
      mergedConfig.supervisorDefaults.supervisors.session,
      "session supervisor config should exist",
    );
    assertExists(
      mergedConfig.supervisorDefaults.supervisors.workspace,
      "workspace supervisor config should exist",
    );
    assertExists(
      mergedConfig.supervisorDefaults.supervisors.agent,
      "agent supervisor config should exist",
    );

    // Verify session supervisor has expected properties
    const sessionConfig = mergedConfig.supervisorDefaults.supervisors.session;
    assertExists(sessionConfig.model, "session supervisor should have model");
    assertExists(sessionConfig.prompts, "session supervisor should have prompts");
  } finally {
    try {
      await Deno.remove("workspace.yml");
    } catch {
      // Ignore cleanup errors
    }
  }
});

Deno.test("SessionSupervisor - accepts and uses supervisor defaults", () => {
  const mockSupervisorDefaults = {
    supervisors: {
      session: {
        model: "claude-3-5-sonnet-20241022",
        prompts: {
          system: "Test session supervisor system prompt",
          task_preparation: "Test task preparation prompt",
        },
        task_format: {
          type: "structured",
          template: "action_oriented",
        },
      },
    },
  };

  const supervisor = new SessionSupervisor(
    testMemoryConfig,
    "test-workspace",
    {},
    mockSupervisorDefaults,
  );

  assertExists(supervisor, "SessionSupervisor should be created");
  assertEquals(supervisor.name(), "SessionSupervisor");

  // Verify supervisor defaults are stored
  const supervisorDefaults = (supervisor as any).supervisorDefaults;
  assertExists(supervisorDefaults, "supervisorDefaults should be stored");
  assertEquals(supervisorDefaults.supervisors.session.model, "claude-3-5-sonnet-20241022");
  assertEquals(
    supervisorDefaults.supervisors.session.prompts.system,
    "Test session supervisor system prompt",
  );
});

Deno.test("SessionSupervisor - MCP tools architecture uses new structure", () => {
  const supervisor = new SessionSupervisor(testMemoryConfig, "test-workspace", {});

  // Test the new workspace tools structure
  const testTools = {
    mcp: {
      servers: {
        "file-server": {
          transport: "stdio",
          command: "node",
          args: ["file-server.js"],
        },
        "web-server": {
          transport: "http",
          endpoint: "http://localhost:3000",
        },
      },
    },
  };

  supervisor.setWorkspaceTools(testTools);

  // Test getMcpServerConfigsForAgent uses new structure
  const mcpConfigs = supervisor.getMcpServerConfigsForAgent("test-agent", [
    "file-server",
    "web-server",
  ]);

  assertEquals(mcpConfigs.length, 2);
  assertEquals(mcpConfigs[0].id, "file-server");
  assertEquals(mcpConfigs[0].transport, "stdio");
  assertEquals(mcpConfigs[1].id, "web-server");
  assertEquals(mcpConfigs[1].transport, "http");
});

Deno.test("SessionSupervisor - task preparation uses reasoning engine not hardcoded prompts", async () => {
  const supervisor = new SessionSupervisor(testMemoryConfig, "test-workspace", {});

  // Mock the generateLLM method (which is what the task preparation actually uses)
  let llmGenerationCalled = false;
  (supervisor as any).generateLLM = async (
    model: string,
    system: string,
    prompt: string,
    streaming: boolean,
    metadata: any,
  ) => {
    llmGenerationCalled = true;
    assertExists(model, "Model should be provided");
    assertExists(prompt, "Prompt should be provided");
    return `Task: Execute test task for agent ${metadata.agentId}`;
  };

  // Mock the getAgentCapabilitiesDescription method
  (supervisor as any).getAgentCapabilitiesDescription = (agentId: string, agents: any[]) => {
    return `Capabilities for ${agentId}: LLM reasoning, task execution`;
  };

  // Mock the getTaskRequirementsForAgentType method
  (supervisor as any).getTaskRequirementsForAgentType = (agentType: string, agentId: string) => {
    return `Requirements for ${agentType} agent: Follow instructions, return results`;
  };

  // Mock the extractSignalDataSummary method
  (supervisor as any).extractSignalDataSummary = (data: any) => {
    return `Signal data: ${JSON.stringify(data)}`;
  };

  const mockAgentSpec = { id: "test-agent", mode: "test" };
  const mockJobSpec = {
    name: "test-job",
    description: "Test job description",
    execution: { strategy: "sequential" as const, agents: [mockAgentSpec] },
  };
  const mockSessionContext = {
    sessionId: "test-session",
    workspaceId: "test-workspace",
    signal: { id: "test-signal" },
    payload: { test: "data" },
    availableAgents: [{ id: "test-agent", type: "llm", purpose: "Test agent" }],
    filteredMemory: [],
  };

  // Call task preparation
  const task = await (supervisor as any).generateIntelligentTaskPrompt(
    mockAgentSpec,
    mockJobSpec,
    { test: "signal data" },
    mockSessionContext,
  );

  assertEquals(llmGenerationCalled, true, "LLM generation should be called for task preparation");
  assertExists(task, "Task should be generated");
  assertEquals(typeof task, "string");
});

Deno.test("SessionSupervisor - signal processing is generic (not K8s-specific)", () => {
  const supervisor = new SessionSupervisor(testMemoryConfig, "test-workspace", {});

  // Test various signal types (not just K8s)
  const httpSignal = {
    type: "http",
    method: "POST",
    path: "/webhook",
    data: "test data",
  };

  const webhookSignal = {
    type: "webhook",
    source: "github",
    event: "push",
    repository: "test-repo",
  };

  const k8sSignal = {
    type: "k8s",
    event: {
      type: "Warning",
      reason: "FailedMount",
      involvedObject: { kind: "Pod", name: "test-pod" },
    },
  };

  const customSignal = {
    type: "custom",
    source: "my-system",
    action: "data-update",
    metadata: { version: "1.0" },
  };

  // Test generic signal data extraction
  const httpSummary = (supervisor as any).extractSignalDataSummary(httpSignal);
  const webhookSummary = (supervisor as any).extractSignalDataSummary(webhookSignal);
  const k8sSummary = (supervisor as any).extractSignalDataSummary(k8sSignal);
  const customSummary = (supervisor as any).extractSignalDataSummary(customSignal);

  // Verify all signal types are handled
  assertExists(httpSummary, "HTTP signal summary should be generated");
  assertExists(webhookSummary, "Webhook signal summary should be generated");
  assertExists(k8sSummary, "K8s signal summary should be generated");
  assertExists(customSummary, "Custom signal summary should be generated");

  // Verify they contain expected content
  assertEquals(httpSummary.includes("POST"), true, "HTTP signal should include method");
  assertEquals(webhookSummary.includes("github"), true, "Webhook signal should include source");
  assertEquals(k8sSummary.includes("Warning"), true, "K8s signal should include event type");
  assertEquals(customSummary.includes("my-system"), true, "Custom signal should include source");
});

Deno.test("SessionSupervisor - output formatting adapts library patterns", async () => {
  const mockSupervisorDefaults = {
    supervisors: {
      session: {
        task_format: {
          type: "structured",
          template: "action_oriented",
          include_context: true,
          include_requirements: true,
        },
      },
    },
  };

  const supervisor = new SessionSupervisor(
    testMemoryConfig,
    "test-workspace",
    {},
    mockSupervisorDefaults,
  );

  // Test format task output method
  const mockTaskContent = "Execute the test operation";
  const mockMetadata = {
    agentId: "test-agent",
    agentType: "llm",
    signalId: "test-signal",
    jobName: "test-job",
  };

  const formattedTask = (supervisor as any).formatTaskOutput(
    mockTaskContent,
    mockSupervisorDefaults.supervisors.session.task_format,
    mockMetadata,
  );

  assertExists(formattedTask, "Formatted task should be generated");
  assertEquals(formattedTask.includes("## Context"), true, "Should include context section");
  assertEquals(formattedTask.includes("## Task"), true, "Should include task section");
  assertEquals(
    formattedTask.includes("## Requirements"),
    true,
    "Should include requirements section",
  );
  assertEquals(formattedTask.includes("test-agent"), true, "Should include agent ID");
  assertEquals(formattedTask.includes("test-signal"), true, "Should include signal ID");
});
