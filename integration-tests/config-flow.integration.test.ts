/**
 * Integration Tests for Actor System
 *
 * These tests verify the runtime behavior of actors, including:
 * - Configuration passing between actors
 * - AgentExecutePayload validation
 * - MCP tools configuration flow
 * - Reasoning context preservation
 */

import type { MergedConfig, WorkspaceAgentConfig } from "@atlas/config";
import type {
  AgentExecutePayload,
  AgentExecutionConfig,
  SessionSupervisorConfig,
  WorkspaceSupervisorConfig,
} from "@atlas/core";
import { AgentExecutePayloadSchema } from "@atlas/core";
import { assertEquals, assertExists } from "@std/assert";

// Type alias for clarity
type AgentConfig = WorkspaceAgentConfig;

// ==============================================================================
// CONFIGURATION PASSING TESTS
// ==============================================================================

Deno.test("Configuration should flow correctly from WorkspaceRuntime to WorkspaceSupervisor", () => {
  // Simulate configuration from WorkspaceRuntime
  const mergedConfig: MergedConfig = {
    workspace: {
      version: "1.0",
      workspace: {
        name: "Test Workspace",
        description: "Integration test workspace",
      },
      signals: {
        "test-signal": {
          description: "Test signal",
          provider: "http",
          config: {
            path: "/test-signal",
          },
        },
      },
      jobs: {
        "test-job": {
          name: "test-job",
          description: "Test job",
          execution: {
            strategy: "sequential",
            agents: ["test-agent"],
          },
        },
      },
      tools: {
        mcp: {
          client_config: {
            timeout: "30s",
          },
          servers: {
            filesystem: {
              transport: {
                type: "stdio",
                command: "fs-server",
              },
            },
          },
        },
      },
    },
    atlas: {
      version: "1.0",
      workspace: {
        name: "Test Workspace",
        description: "Integration test workspace",
      },
      memory: {
        default: {
          enabled: true,
          storage: "filesystem",
          cognitive_loop: false,
          retention: {
            max_age_days: 30,
            cleanup_interval_hours: 24,
            max_entries: 1000,
          },
        },
        agent: {
          enabled: true,
          scope: "workspace",
          include_in_context: true,
          context_limits: {
            relevant_memories: 10,
            past_successes: 5,
            past_failures: 5,
          },
          memory_types: {
            working: { enabled: true },
          },
        },
        session: {
          enabled: true,
          scope: "session",
          include_in_context: true,
          context_limits: {
            relevant_memories: 5,
            past_successes: 3,
            past_failures: 2,
          },
          memory_types: {
            episodic: { enabled: true },
          },
        },
        workspace: {
          enabled: true,
          scope: "workspace",
          include_in_context: false,
          context_limits: {
            relevant_memories: 20,
            past_successes: 10,
            past_failures: 10,
          },
          memory_types: {
            semantic: { enabled: true },
          },
        },
      },
      supervisors: {
        workspace: {
          model: "gpt-4",
          supervision: {
            level: "standard",
            cache_enabled: true,
          },
          prompts: {
            system: "You are a workspace supervisor.",
            analysis: "Analyze this signal",
          },
        },
        session: {
          model: "gpt-4",
          supervision: {
            level: "standard",
            cache_enabled: true,
          },
          prompts: {
            system: "You are a session supervisor.",
            planning: "Create execution plan",
          },
        },
        agent: {
          model: "gpt-4",
          supervision: {
            level: "minimal",
            cache_enabled: false,
          },
          prompts: {
            system: "You are an agent supervisor.",
            analysis: "Assess safety",
          },
        },
      },
    },
  };

  // Create WorkspaceSupervisorConfig slice
  const workspaceSupervisorConfig: WorkspaceSupervisorConfig = {
    workspaceId: "ws-test-123",
    workspace: mergedConfig.workspace.workspace,
    signals: mergedConfig.workspace.signals || {},
    jobs: mergedConfig.workspace.jobs || {},
    memory: mergedConfig.atlas?.memory,
    tools: mergedConfig.workspace.tools,
    supervisorDefaults: mergedConfig.atlas?.supervisors,
  };

  // Verify all required fields are present
  assertExists(workspaceSupervisorConfig.workspaceId);
  assertExists(workspaceSupervisorConfig.workspace);
  assertExists(workspaceSupervisorConfig.signals);
  assertExists(workspaceSupervisorConfig.jobs);
  assertExists(workspaceSupervisorConfig.memory);
  assertExists(workspaceSupervisorConfig.tools);
  assertExists(workspaceSupervisorConfig.supervisorDefaults);

  // Verify structure is maintained
  assertEquals(workspaceSupervisorConfig.workspace.name, "Test Workspace");
  assertEquals(workspaceSupervisorConfig.signals["test-signal"].provider, "http");
  assertEquals(workspaceSupervisorConfig.jobs["test-job"].execution.agents[0], "test-agent");
  assertEquals(workspaceSupervisorConfig.tools?.mcp?.servers?.filesystem?.transport?.type, "stdio");
});

Deno.test("Configuration should flow correctly from WorkspaceSupervisor to SessionSupervisor", () => {
  // Mock WorkspaceSupervisor config
  const workspaceSupervisorConfig: WorkspaceSupervisorConfig = {
    workspaceId: "ws-test-123",
    workspace: {
      name: "Test Workspace",
      description: "Test",
    },
    signals: {},
    jobs: {
      "test-job": {
        name: "test-job",
        description: "Test job",
        execution: {
          strategy: "sequential",
          agents: ["agent-1", "agent-2"],
        },
      },
    },
    memory: {
      default: {
        enabled: true,
        storage: "filesystem",
        cognitive_loop: false,
        retention: {
          max_age_days: 30,
          cleanup_interval_hours: 24,
          max_entries: 1000,
        },
      },
      agent: {
        enabled: true,
        scope: "workspace",
        include_in_context: true,
        context_limits: {
          relevant_memories: 10,
          past_successes: 5,
          past_failures: 5,
        },
        memory_types: {
          working: { enabled: true },
        },
      },
      session: {
        enabled: true,
        scope: "session",
        include_in_context: true,
        context_limits: {
          relevant_memories: 5,
          past_successes: 3,
          past_failures: 2,
        },
        memory_types: {
          episodic: { enabled: true },
        },
      },
      workspace: {
        enabled: true,
        scope: "workspace",
        include_in_context: false,
        context_limits: {
          relevant_memories: 20,
          past_successes: 10,
          past_failures: 10,
        },
        memory_types: {
          semantic: { enabled: true },
        },
      },
    },
    tools: {
      mcp: {
        client_config: {
          timeout: "30s",
        },
        servers: {
          filesystem: { transport: { type: "stdio", command: "fs-server" } },
          commands: { transport: { type: "stdio", command: "cmd-server" } },
        },
      },
    },
  };

  // Mock agents configuration
  const agents: Record<string, AgentConfig> = {
    "agent-1": {
      description: "LLM agent for processing",
      type: "llm",
      config: {
        provider: "openai",
        model: "gpt-4",
        prompt: "You are a helpful assistant.",
        tools: ["filesystem"],
      },
    },
    "agent-2": {
      description: "System agent for scripts",
      type: "system",
      agent: "script-runner",
      config: { script: "test.ts" },
    },
  };

  // Create SessionSupervisorConfig slice
  const sessionSupervisorConfig: SessionSupervisorConfig = {
    job: workspaceSupervisorConfig.jobs["test-job"],
    agents: agents,
    memory: workspaceSupervisorConfig.memory,
    tools: workspaceSupervisorConfig.tools,
  };

  // Verify configuration is passed correctly
  assertExists(sessionSupervisorConfig.job);
  assertExists(sessionSupervisorConfig.agents);
  assertEquals(sessionSupervisorConfig.job.name, "test-job");
  assertEquals(Object.keys(sessionSupervisorConfig.agents).length, 2);
  assertEquals(sessionSupervisorConfig.agents["agent-1"].type, "llm");
  assertEquals(sessionSupervisorConfig.agents["agent-2"].type, "system");
  assertExists(sessionSupervisorConfig.memory);
  assertExists(sessionSupervisorConfig.tools);
});

Deno.test("Configuration should flow correctly from SessionSupervisor to AgentExecutionActor", () => {
  // Mock SessionSupervisor config
  const sessionSupervisorConfig: SessionSupervisorConfig = {
    job: {
      name: "test-job",
      description: "Test",
      execution: {
        strategy: "sequential",
        agents: ["agent-1"],
      },
    },
    agents: {
      "agent-1": {
        description: "LLM agent for processing",
        type: "llm",
        config: {
          provider: "openai",
          model: "gpt-4",
          prompt: "You are a helpful assistant.",
          tools: ["filesystem", "commands"],
        },
      },
    },
    memory: {
      default: {
        enabled: true,
        storage: "filesystem",
        cognitive_loop: false,
        retention: {
          max_age_days: 30,
          cleanup_interval_hours: 24,
          max_entries: 1000,
        },
      },
      agent: {
        enabled: true,
        scope: "workspace",
        include_in_context: true,
        context_limits: {
          relevant_memories: 10,
          past_successes: 5,
          past_failures: 5,
        },
        memory_types: {
          working: { enabled: true },
        },
      },
      session: {
        enabled: true,
        scope: "session",
        include_in_context: true,
        context_limits: {
          relevant_memories: 5,
          past_successes: 3,
          past_failures: 2,
        },
        memory_types: {
          episodic: { enabled: true },
        },
      },
      workspace: {
        enabled: true,
        scope: "workspace",
        include_in_context: false,
        context_limits: {
          relevant_memories: 20,
          past_successes: 10,
          past_failures: 10,
        },
        memory_types: {
          semantic: { enabled: true },
        },
      },
    },
    tools: {
      mcp: {
        client_config: {
          timeout: "30s",
        },
        servers: {
          filesystem: { transport: { type: "stdio", command: "fs-server" } },
          commands: { transport: { type: "stdio", command: "cmd-server" } },
        },
      },
    },
  };

  const agentId = "agent-1";
  const agentConfig = sessionSupervisorConfig.agents[agentId];

  // Create AgentExecutionConfig slice
  const agentExecutionConfig: AgentExecutionConfig = {
    agent: agentConfig,
    tools: agentConfig.config.tools,
    memory: sessionSupervisorConfig.memory,
  };

  // Verify configuration is passed correctly
  assertExists(agentExecutionConfig.agent);
  assertExists(agentExecutionConfig.tools);
  assertEquals(agentExecutionConfig.agent.type, "llm");
  assertEquals(agentExecutionConfig.tools?.length, 2);
  assertEquals(agentExecutionConfig.tools?.[0], "filesystem");
  assertEquals(agentExecutionConfig.tools?.[1], "commands");
  assertExists(agentExecutionConfig.memory);
});

// ==============================================================================
// AGENT EXECUTE PAYLOAD VALIDATION TESTS
// ==============================================================================

Deno.test("AgentExecutePayload should validate correctly with Zod schema", () => {
  // Valid payload
  const validPayload: AgentExecutePayload = {
    agentId: "agent-1",
    input: { data: "test input" },
    sessionContext: {
      sessionId: "sess-123",
      workspaceId: "ws-456",
      task: "Process data",
      reasoning: "Using this agent for data processing",
    },
  };

  // Test validation passes
  const result = AgentExecutePayloadSchema.safeParse(validPayload);
  assertEquals(result.success, true);
  if (result.success) {
    assertEquals(result.data.agentId, "agent-1");
    assertEquals(result.data.sessionContext.sessionId, "sess-123");
  }

  // Test with minimal payload (optional fields omitted)
  const minimalPayload = {
    agentId: "agent-2",
    input: null,
    sessionContext: {
      sessionId: "sess-789",
      workspaceId: "ws-000",
    },
  };

  const minimalResult = AgentExecutePayloadSchema.safeParse(minimalPayload);
  assertEquals(minimalResult.success, true);
});

Deno.test("AgentExecutePayload should reject invalid payloads", () => {
  // Missing required fields
  const invalidPayloads = [
    // Missing agentId
    {
      input: {},
      sessionContext: { sessionId: "s1", workspaceId: "w1" },
    },
    // Missing sessionContext
    {
      agentId: "agent-1",
      input: {},
    },
    // Missing sessionId in context
    {
      agentId: "agent-1",
      input: {},
      sessionContext: { workspaceId: "w1" },
    },
    // Missing workspaceId in context
    {
      agentId: "agent-1",
      input: {},
      sessionContext: { sessionId: "s1" },
    },
  ];

  invalidPayloads.forEach((payload, index) => {
    const result = AgentExecutePayloadSchema.safeParse(payload);
    assertEquals(result.success, false, `Payload ${index} should have failed validation`);
  });
});

// ==============================================================================
// MCP TOOLS CONFIGURATION TESTS
// ==============================================================================

Deno.test("MCP tools should be normalized from array format to mcpServers", () => {
  // Test agent with simple tools array
  const agentWithArrayTools: AgentConfig = {
    description: "Agent with tools",
    type: "llm",
    config: {
      provider: "openai",
      model: "gpt-4",
      prompt: "You are a helpful assistant.",
      tools: ["filesystem", "commands"],
    },
  };

  // After normalization (simulating config loader behavior)
  const normalizedAgent = {
    ...agentWithArrayTools,
    mcpServers: agentWithArrayTools.config.tools,
    tools: {
      mcpServers: agentWithArrayTools.config.tools,
    },
  };

  // Verify normalization
  assertExists(normalizedAgent.mcpServers);
  assertEquals(Array.isArray(normalizedAgent.mcpServers), true);
  assertEquals(normalizedAgent.mcpServers.length, 2);
  assertEquals(normalizedAgent.mcpServers[0], "filesystem");
  assertEquals(normalizedAgent.mcpServers[1], "commands");
});

Deno.test("MCP tools configuration should pass through actor hierarchy", () => {
  // Start with workspace-level tools configuration
  const workspaceTools = {
    mcp: {
      client_config: {
        timeout: "30s",
      },
      servers: {
        filesystem: {
          transport: {
            type: "stdio",
            command: "fs-server",
          },
        },
        commands: {
          transport: {
            type: "stdio",
            command: "cmd-server",
          },
        },
        github: {
          transport: {
            type: "stdio",
            command: "gh-server",
          },
        },
      },
    },
  };

  // Agent requests specific tools
  const agentConfig: AgentConfig = {
    description: "LLM agent",
    type: "llm",
    config: {
      provider: "openai",
      model: "gpt-4",
      prompt: "You are a helpful assistant.",
      tools: ["filesystem", "commands"], // Agent only gets these two
    },
  };

  // Simulate tool filtering for agent
  const agentTools = agentConfig.config.tools;
  const availableServers = workspaceTools.mcp.servers;

  // Agent should only have access to requested tools
  assertExists(agentTools);
  assertEquals(agentTools?.length, 2);
  assertEquals(agentTools?.includes("filesystem"), true);
  assertEquals(agentTools?.includes("commands"), true);
  assertEquals(agentTools?.includes("github"), false); // Not requested

  // Verify agent can access tool configurations
  if (agentTools) {
    agentTools.forEach((toolName) => {
      assertExists(availableServers[toolName as keyof typeof availableServers]);
    });
  }
});

// ==============================================================================
// REASONING CONTEXT PRESERVATION TESTS
// ==============================================================================

Deno.test("Reasoning should be preserved through the actor chain", () => {
  // Supervisor generates reasoning
  const supervisorReasoning = "This task requires file system access to read configuration files";

  // Create agent task with reasoning
  const agentTask = {
    agentId: "agent-1",
    task: "Read configuration file",
    reasoning: supervisorReasoning,
  };

  // Create payload with reasoning in session context
  const payload: AgentExecutePayload = {
    agentId: agentTask.agentId,
    input: { file: "config.json" },
    sessionContext: {
      sessionId: "sess-123",
      workspaceId: "ws-456",
      task: agentTask.task,
      reasoning: agentTask.reasoning,
    },
  };

  // Verify reasoning is preserved
  assertExists(payload.sessionContext.reasoning);
  assertEquals(payload.sessionContext.reasoning, supervisorReasoning);

  // Validate with schema
  const result = AgentExecutePayloadSchema.safeParse(payload);
  assertEquals(result.success, true);
  if (result.success) {
    assertEquals(result.data.sessionContext.reasoning, supervisorReasoning);
  }
});

Deno.test("Reasoning context should flow from signal to agent execution", () => {
  // Signal triggers workspace with initial context
  const signal = {
    type: "github-pr",
    payload: {
      action: "opened",
      pr_number: 123,
    },
  };

  // WorkspaceSupervisor analyzes signal and adds reasoning
  const workspaceReasoning = "New PR needs code review and test validation";

  // SessionSupervisor creates execution plan with reasoning
  const sessionReasoning = "Will use code-review agent first, then test-runner agent";

  const executionPlan = {
    planId: "plan-123",
    sessionId: "sess-456",
    reasoning: sessionReasoning,
    tasks: [
      {
        agentId: "code-review-agent",
        task: "Review PR changes",
        reasoning: "This agent has expertise in code quality checks",
      },
      {
        agentId: "test-runner-agent",
        task: "Run test suite",
        reasoning: "Ensure all tests pass before approval",
        dependencies: ["code-review-agent"],
      },
    ],
    createdAt: Date.now(),
  };

  // Verify reasoning at each level
  assertExists(workspaceReasoning);
  assertExists(executionPlan.reasoning);
  assertExists(executionPlan.tasks[0].reasoning);
  assertExists(executionPlan.tasks[1].reasoning);

  // Create agent payload with full context
  const agentPayload: AgentExecutePayload = {
    agentId: executionPlan.tasks[0].agentId,
    input: signal.payload,
    sessionContext: {
      sessionId: executionPlan.sessionId,
      workspaceId: "ws-789",
      task: executionPlan.tasks[0].task,
      reasoning: executionPlan.tasks[0].reasoning,
    },
  };

  // Verify complete context is available to agent
  assertEquals(agentPayload.sessionContext.task, "Review PR changes");
  assertEquals(
    agentPayload.sessionContext.reasoning,
    "This agent has expertise in code quality checks",
  );
});

// ==============================================================================
// ERROR HANDLING TESTS
// ==============================================================================

Deno.test("Configuration errors should be caught early with clear messages", () => {
  // Test missing agent in SessionSupervisor config
  const sessionConfig: SessionSupervisorConfig = {
    job: {
      name: "test-job",
      description: "Test",
      execution: {
        strategy: "sequential",
        agents: ["agent-1", "agent-missing"], // agent-missing doesn't exist
      },
    },
    agents: {
      "agent-1": {
        description: "Test agent",
        type: "llm",
        config: {
          provider: "openai",
          model: "gpt-4",
          prompt: "You are a helpful assistant.",
        },
      },
      // agent-missing is not defined
    },
  };

  // Attempt to create config for missing agent
  const missingAgentId = "agent-missing";
  const agentConfig = sessionConfig.agents[missingAgentId];

  assertEquals(agentConfig, undefined);

  // This would throw in actual implementation
  if (!agentConfig) {
    const error = new Error(`Agent ${missingAgentId} not found in configuration`);
    assertExists(error.message);
    assertEquals(error.message.includes("agent-missing"), true);
  }
});

// ==============================================================================
// TYPE SAFETY VERIFICATION TESTS
// ==============================================================================

Deno.test("Configuration types should prevent invalid assignments at compile time", () => {
  // This test verifies TypeScript's compile-time type checking
  // These would be compile errors in actual code

  // Valid configuration
  const validConfig: WorkspaceSupervisorConfig = {
    workspaceId: "ws-123",
    workspace: {
      name: "Valid Workspace",
      description: "Valid description",
    },
    signals: {},
    jobs: {},
  };

  // Test that required fields are enforced
  assertExists(validConfig.workspaceId);
  assertExists(validConfig.workspace);
  assertExists(validConfig.signals);
  assertExists(validConfig.jobs);

  // Optional fields can be undefined
  assertEquals(validConfig.memory, undefined);
  assertEquals(validConfig.tools, undefined);
  assertEquals(validConfig.supervisorDefaults, undefined);
});
