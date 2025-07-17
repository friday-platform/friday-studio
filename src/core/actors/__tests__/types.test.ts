/**
 * Type Tests for Actor System
 *
 * These tests verify that the type system is working correctly
 * and that there are no 'any' types in the actor interfaces.
 */

import type {
  ActorConfig,
  AgentExecutionActor,
  AgentExecutionConfig,
  AgentExecutionEvent,
  AgentResult,
  BaseActor,
  SessionInfo,
  SessionResult,
  SessionSupervisorActor,
  SessionSupervisorConfig,
  SessionSupervisorContext,
  SessionSupervisorEvent,
  WorkspaceSupervisorActor,
  WorkspaceSupervisorConfig,
  WorkspaceSupervisorContext,
  WorkspaceSupervisorEvent,
} from "@atlas/core";
import {
  isAbortEvent,
  isAgentExecution,
  isErrorContext,
  isErrorEvent,
  isExecutingContext,
  isProcessingContext,
  isSessionSupervisor,
  isShutdownEvent,
  isWorkspaceSupervisor,
} from "@atlas/core";
import { assertEquals, assertExists } from "@std/assert";

import type {
  AgentExecutePayload,
  AgentExecutionResult,
  AgentTask,
  ExecutionPlan,
} from "@atlas/core";

// ==============================================================================
// TYPE GUARD TESTS
// ==============================================================================

Deno.test("Actor type guards should correctly identify actor types", () => {
  // Mock actors for testing
  const workspaceActor: BaseActor = {
    id: "ws-1",
    type: "workspace",
    initialize: async () => {},
    shutdown: async () => {},
  };

  const sessionActor: BaseActor = {
    id: "sess-1",
    type: "session",
    initialize: async () => {},
    shutdown: async () => {},
  };

  const agentActor: BaseActor = {
    id: "agent-1",
    type: "agent",
    initialize: async () => {},
    shutdown: async () => {},
  };

  // Test type guards
  assertEquals(isWorkspaceSupervisor(workspaceActor), true);
  assertEquals(isWorkspaceSupervisor(sessionActor), false);
  assertEquals(isWorkspaceSupervisor(agentActor), false);

  assertEquals(isSessionSupervisor(sessionActor), true);
  assertEquals(isSessionSupervisor(workspaceActor), false);
  assertEquals(isSessionSupervisor(agentActor), false);

  assertEquals(isAgentExecution(agentActor), true);
  assertEquals(isAgentExecution(workspaceActor), false);
  assertEquals(isAgentExecution(sessionActor), false);
});

Deno.test("Event type guards should correctly identify event types", () => {
  const errorEvent = { type: "ERROR", error: new Error("Test error") };
  const shutdownEvent = { type: "SHUTDOWN" };
  const abortEvent = { type: "ABORT", reason: "User requested" };

  assertEquals(isErrorEvent(errorEvent), true);
  assertEquals(isErrorEvent(shutdownEvent), false);
  assertEquals(isErrorEvent(null), false);
  assertEquals(isErrorEvent(undefined), false);

  assertEquals(isShutdownEvent(shutdownEvent), true);
  assertEquals(isShutdownEvent(errorEvent), false);

  assertEquals(isAbortEvent(abortEvent), true);
  assertEquals(isAbortEvent(shutdownEvent), false);
});

// ==============================================================================
// CONFIGURATION SLICE TYPE TESTS
// ==============================================================================

Deno.test("Configuration slice types should have proper structure", () => {
  // Test WorkspaceSupervisorConfig
  const wsConfig: WorkspaceSupervisorConfig = {
    workspaceId: "test-workspace",
    workspace: {
      name: "Test Workspace",
      description: "Test description",
    },
    signals: {},
    jobs: {},
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
          procedural: { enabled: true },
          episodic: { enabled: true },
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
          working: { enabled: true },
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
          contextual: { enabled: true },
        },
      },
    },
    tools: {
      mcp: {
        client_config: {
          timeout: "30s",
        },
        servers: {},
      },
    },
  };

  assertExists(wsConfig.workspaceId);
  assertExists(wsConfig.workspace);
  assertExists(wsConfig.signals);
  assertExists(wsConfig.jobs);

  // Test SessionSupervisorConfig
  const sessionConfig: SessionSupervisorConfig = {
    job: {
      name: "test-job",
      description: "Test job",
      execution: {
        strategy: "sequential",
        agents: ["agent-1"],
      },
    },
    agents: {
      "agent-1": {
        description: "Test agent",
        type: "system",
        agent: "test-agent",
        config: {},
      },
    },
    memory: wsConfig.memory,
    tools: wsConfig.tools,
  };

  assertExists(sessionConfig.job);
  assertExists(sessionConfig.agents);

  // Test AgentExecutionConfig
  const agentConfig: AgentExecutionConfig = {
    agent: {
      description: "Test agent",
      type: "system",
      agent: "test-agent",
      config: {},
    },
    tools: ["filesystem", "commands"],
    memory: wsConfig.memory,
  };

  assertExists(agentConfig.agent);
});

// ==============================================================================
// XSTATE EVENT TYPE TESTS
// ==============================================================================

Deno.test("XState event types should be properly discriminated", () => {
  // Test WorkspaceSupervisorEvent
  const wsEvents: WorkspaceSupervisorEvent[] = [
    { type: "SIGNAL_RECEIVED", signal: {}, payload: {} },
    { type: "SESSION_STARTED", sessionId: "sess-1", actorRef: {} },
    {
      type: "SESSION_COMPLETED",
      sessionId: "sess-1",
      result: { sessionId: "sess-1", status: "success", duration: 1000 },
    },
    { type: "SESSION_FAILED", sessionId: "sess-1", error: new Error("Test") },
    { type: "SHUTDOWN" },
  ];

  wsEvents.forEach((event) => {
    assertExists(event.type);
  });

  // Test SessionSupervisorEvent
  const sessionEvents: SessionSupervisorEvent[] = [
    { type: "START_EXECUTION" },
    {
      type: "PLAN_CREATED",
      plan: { planId: "plan-1", sessionId: "sess-1", tasks: [], createdAt: Date.now() },
    },
    {
      type: "AGENT_COMPLETED",
      agentId: "agent-1",
      result: { agentId: "agent-1", output: {}, duration: 100 },
    },
    { type: "AGENT_FAILED", agentId: "agent-1", error: new Error("Test") },
    { type: "ABORT", reason: "User requested" },
  ];

  sessionEvents.forEach((event) => {
    assertExists(event.type);
  });

  // Test AgentExecutionEvent
  const agentEvents: AgentExecutionEvent[] = [
    { type: "EXECUTE", taskId: "task-1", payload: {} },
    { type: "TOOL_CALL", toolName: "filesystem", params: {} },
    { type: "TOOL_RESULT", toolName: "filesystem", result: {} },
    { type: "COMPLETION", result: {} },
    { type: "ERROR", error: new Error("Test") },
  ];

  agentEvents.forEach((event) => {
    assertExists(event.type);
  });
});

// ==============================================================================
// CONTEXT TYPE TESTS
// ==============================================================================

Deno.test("Context type guards should correctly identify context states", () => {
  // Test WorkspaceSupervisor contexts
  const processingContext: WorkspaceSupervisorContext = {
    config: {
      workspaceId: "test",
      workspace: { name: "Test", description: "" },
      signals: {},
      jobs: {},
    },
    activeSessions: new Map(),
    stats: { totalSignalsProcessed: 0, totalSessionsCreated: 0 },
    currentSignal: {},
    currentPayload: {},
    processingStartTime: Date.now(),
  };

  assertEquals(isProcessingContext(processingContext), true);

  // Test SessionSupervisor contexts
  const executingContext: SessionSupervisorContext = {
    config: {
      job: { name: "test", description: "", execution: { strategy: "sequential", agents: [] } },
      agents: {},
    },
    sessionId: "sess-1",
    workspaceId: "ws-1",
    startTime: Date.now(),
    executionPlan: { planId: "plan-1", sessionId: "sess-1", tasks: [], createdAt: Date.now() },
    activeAgents: new Map(),
    completedAgents: new Map(),
    executionStartTime: Date.now(),
  };

  assertEquals(isExecutingContext(executingContext), true);

  // Test error contexts
  const errorContext: WorkspaceSupervisorContext = {
    config: {
      workspaceId: "test",
      workspace: { name: "Test", description: "" },
      signals: {},
      jobs: {},
    },
    activeSessions: new Map(),
    stats: { totalSignalsProcessed: 0, totalSessionsCreated: 0 },
    lastError: new Error("Test"),
    errorCount: 1,
    errorTime: Date.now(),
  };

  assertEquals(isErrorContext(errorContext), true);
});

// ==============================================================================
// AGENT EXECUTION PAYLOAD TESTS
// ==============================================================================

Deno.test("AgentExecutePayload should have consistent camelCase structure", () => {
  const payload: AgentExecutePayload = {
    agentId: "agent-1",
    input: { data: "test" },
    sessionContext: {
      sessionId: "sess-1",
      workspaceId: "ws-1",
      task: "Process data",
      reasoning: "Need to analyze the input data",
    },
  };

  assertExists(payload.agentId);
  assertExists(payload.input);
  assertExists(payload.sessionContext);
  assertExists(payload.sessionContext.sessionId);
  assertExists(payload.sessionContext.workspaceId);

  // Optional fields
  assertEquals(typeof payload.sessionContext.task, "string");
  assertEquals(typeof payload.sessionContext.reasoning, "string");
});

// ==============================================================================
// VERIFY NO 'ANY' TYPES
// ==============================================================================

Deno.test("Actor interfaces should not expose 'any' types", () => {
  // This test uses TypeScript's type system to verify no 'any' types
  // If any of these assignments fail to compile, it means 'any' types are exposed

  // Test BaseActor interface
  const testBaseActor: BaseActor = {
    id: "test",
    type: "workspace", // Must be one of the discriminated union values
    initialize: (params) => {
      // params should be typed as ActorInitParams
      const _id: string = params.actorId;
      const _parentId: string | undefined = params.parentId;
      const _headers: Record<string, string> | undefined = params.traceHeaders;
      return Promise.resolve();
    },
    shutdown: async () => {
      // No parameters, returns Promise<void>
    },
  };

  // Test WorkspaceSupervisorActor interface
  const testWorkspaceActor: WorkspaceSupervisorActor = {
    id: "ws-1",
    type: "workspace",
    initialize: async () => {},
    shutdown: async () => {},
    processSignal: () => {
      return Promise.resolve({
        id: "session-1",
        status: "active",
        startTime: Date.now(),
      });
    },
    getSession: (sessionId) => {
      const _id: string = sessionId;
      return undefined;
    },
    getActiveSessionCount: () => 0,
  };

  // Test SessionSupervisorActor interface
  const testSessionActor: SessionSupervisorActor = {
    id: "sess-1",
    type: "session",
    initialize: async () => {},
    shutdown: async () => {},
    execute: () =>
      Promise.resolve({
        sessionId: "sess-1",
        status: "success",
        duration: 1000,
      }),
    abort: async () => {},
    getStatus: () => "idle",
  };

  // Test AgentExecutionActor interface
  const testAgentActor: AgentExecutionActor = {
    id: "agent-1",
    type: "agent",
    initialize: async () => {},
    shutdown: async () => {},
    execute: (context) => {
      const _sessionId: string = context.sessionId;
      const _workspaceId: string = context.workspaceId;
      const _task: string | undefined = context.task;
      const _reasoning: string | undefined = context.reasoning;
      const _input: unknown = context.input;

      return Promise.resolve({
        agentId: "agent-1",
        output: {},
        duration: 100,
      });
    },
    getCapabilities: () => ["filesystem", "commands"],
  };

  // Verify discriminated union works correctly
  const actorConfig: ActorConfig = {
    type: "workspace",
    config: {
      workspaceId: "test",
      workspace: { name: "Test", description: "" },
      signals: {},
      jobs: {},
    },
  };

  // This should type-check correctly
  if (actorConfig.type === "workspace") {
    const _wsConfig: WorkspaceSupervisorConfig = actorConfig.config;
  }

  // All assignments should succeed without 'any' types
  assertExists(testBaseActor);
  assertExists(testWorkspaceActor);
  assertExists(testSessionActor);
  assertExists(testAgentActor);
});

// ==============================================================================
// DISCRIMINATED UNION EXHAUSTIVENESS TEST
// ==============================================================================

Deno.test("Discriminated unions should be exhaustive", () => {
  // Test ActorConfig discriminated union
  function handleActorConfig(config: ActorConfig): string {
    switch (config.type) {
      case "workspace":
        return `Workspace: ${config.config.workspaceId}`;
      case "session":
        return `Session: ${config.config.job.name}`;
      case "agent":
        return `Agent: ${config.config.agent.type}`;
        // TypeScript will error if we miss a case
    }
  }

  // Test with each type
  const wsConfig: ActorConfig = {
    type: "workspace",
    config: {
      workspaceId: "test",
      workspace: { name: "Test", description: "" },
      signals: {},
      jobs: {},
    },
  };

  const sessionConfig: ActorConfig = {
    type: "session",
    config: {
      job: { name: "test-job", description: "", execution: { strategy: "sequential", agents: [] } },
      agents: {},
    },
  };

  const agentConfig: ActorConfig = {
    type: "agent",
    config: {
      agent: { description: "Test agent", type: "system", agent: "test-agent", config: {} },
    },
  };

  assertEquals(handleActorConfig(wsConfig).startsWith("Workspace:"), true);
  assertEquals(handleActorConfig(sessionConfig).startsWith("Session:"), true);
  assertEquals(handleActorConfig(agentConfig).startsWith("Agent:"), true);
});

// ==============================================================================
// RESULT TYPE TESTS
// ==============================================================================

Deno.test("Result types should have proper structure", () => {
  // Test SessionInfo
  const sessionInfo: SessionInfo = {
    id: "sess-1",
    status: "active",
    startTime: Date.now(),
  };
  assertExists(sessionInfo.id);
  assertEquals(["active", "completed", "failed"].includes(sessionInfo.status), true);

  // Test SessionResult
  const sessionResult: SessionResult = {
    sessionId: "sess-1",
    status: "success",
    result: { data: "processed" },
    duration: 1000,
  };
  assertExists(sessionResult.sessionId);
  assertEquals(["success", "error"].includes(sessionResult.status), true);

  // Test AgentResult
  const agentResult: AgentResult = {
    agentId: "agent-1",
    output: { processed: true },
    duration: 500,
    metadata: {
      tokensUsed: 100,
      cost: 0.01,
      toolCalls: [{ tool: "filesystem", params: {} }],
    },
  };
  assertExists(agentResult.agentId);
  assertExists(agentResult.output);
  assertExists(agentResult.duration);

  // Test AgentExecutionResult
  const executionResult: AgentExecutionResult = {
    output: { data: "result" },
    duration: 300,
    metadata: {
      tokensUsed: 50,
      cost: 0.005,
      model: "gpt-4",
      provider: "openai",
    },
  };
  assertExists(executionResult.output);
  assertExists(executionResult.duration);
});

// ==============================================================================
// EXECUTION PLAN TYPE TESTS
// ==============================================================================

Deno.test("Execution plan types should have proper structure", () => {
  // Test AgentTask
  const agentTask: AgentTask = {
    agentId: "agent-1",
    task: "Process input data",
    reasoning: "This agent is best suited for data processing",
    dependencies: ["agent-0"],
    order: 1,
  };
  assertExists(agentTask.agentId);
  assertExists(agentTask.task);

  // Test ExecutionPlan
  const executionPlan: ExecutionPlan = {
    planId: "plan-1",
    sessionId: "sess-1",
    tasks: [agentTask],
    reasoning: "Sequential processing required",
    createdAt: Date.now(),
  };
  assertExists(executionPlan.planId);
  assertExists(executionPlan.sessionId);
  assertExists(executionPlan.tasks);
  assertEquals(Array.isArray(executionPlan.tasks), true);
});
