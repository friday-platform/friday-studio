import { assertEquals, assertExists } from "@std/assert";
import { AgentSupervisor } from "../../src/core/agent-supervisor.ts";
import type {
  AgentMetadata,
  AgentTask,
  SessionContext,
} from "../../src/core/session-supervisor.ts";

Deno.test("AgentSupervisor - Web Worker Implementation", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  // Create AgentSupervisor
  const supervisorConfig = {
    model: "claude-4-sonnet-20250514",
    capabilities: ["agent_analysis", "safety_assessment", "environment_preparation"],
    prompts: {
      system: "You are an AgentSupervisor responsible for safe agent loading and execution.",
    },
    memoryConfig: {
      default: {
        enabled: true,
        storage: "coala-local",
        cognitive_loop: true,
        retention: {
          max_age_days: 30,
          max_entries: 1000,
          cleanup_interval_hours: 24,
        },
      },
      agent: {
        enabled: true,
        scope: "agent" as const,
        include_in_context: true,
        context_limits: {
          relevant_memories: 10,
          past_successes: 5,
          past_failures: 5,
        },
        memory_types: {
          contextual: { enabled: true, max_entries: 100 },
          episodic: { enabled: true, max_entries: 50 },
          semantic: { enabled: true, max_entries: 200 },
        },
      },
      session: {
        enabled: true,
        scope: "session" as const,
        include_in_context: true,
        context_limits: {
          relevant_memories: 15,
          past_successes: 10,
          past_failures: 10,
        },
        memory_types: {
          contextual: { enabled: true, max_entries: 200 },
          episodic: { enabled: true, max_entries: 100 },
          semantic: { enabled: true, max_entries: 300 },
        },
      },
      workspace: {
        enabled: true,
        scope: "workspace" as const,
        include_in_context: true,
        context_limits: {
          relevant_memories: 20,
          past_successes: 15,
          past_failures: 15,
        },
        memory_types: {
          contextual: { enabled: true, max_entries: 500 },
          episodic: { enabled: true, max_entries: 200 },
          semantic: { enabled: true, max_entries: 1000 },
        },
      },
    },
  };

  const agentSupervisor = new AgentSupervisor(supervisorConfig);

  // Test agent metadata
  const testAgent: AgentMetadata = {
    id: "test-llm-agent",
    name: "Test LLM Agent",
    type: "llm",
    purpose: "Test agent for worker implementation",
    config: {
      type: "llm",
      model: "claude-4-sonnet-20250514",
      purpose: "Test simple text processing",
      prompts: {
        system: "You are a test agent. Echo the input with 'Processed: ' prefix.",
      },
    },
  };

  // Test task
  const testTask: AgentTask = {
    agentId: "test-llm-agent",
    task: "Echo the input message with processing confirmation",
    inputSource: "signal",
  };

  // Mock session context
  const sessionContext: SessionContext = {
    sessionId: "test-session-001",
    workspaceId: "test-workspace",
    signal: {
      id: "test-signal",
      provider: { name: "test-provider" },
    } as any,
    payload: { message: "Hello, Web Worker!" },
    availableAgents: [testAgent],
    filteredMemory: [],
  };

  // Test 1: Agent analysis
  const analysis = await agentSupervisor.analyzeAgent(testAgent, testTask, sessionContext);
  assertExists(analysis);
  assertEquals(typeof analysis.safety_assessment.risk_level, "string");
  assertExists(analysis.resource_requirements);

  // Test 2: Environment preparation
  const environment = await agentSupervisor.prepareEnvironment(testAgent, analysis);
  assertExists(environment);
  assertExists(environment.worker_config);
  assertExists(environment.agent_config);

  // Test 3: Worker loading
  const workerInstance = await agentSupervisor.loadAgentSafely(testAgent, environment);
  assertExists(workerInstance);
  assertEquals(workerInstance.agent_id, testAgent.id);
  assertEquals(workerInstance.status, "ready");

  // Test 4: Supervised execution
  const supervision = {
    pre_execution_checks: ["safety_validation", "resource_check"],
    runtime_monitoring: {
      resource_usage: true,
      output_validation: true,
      safety_monitoring: analysis.safety_assessment.risk_level !== "low",
      timeout_enforcement: true,
    },
    post_execution_validation: {
      output_quality: true,
      success_criteria: true,
      security_compliance: true,
      format_validation: true,
    },
  };

  const result = await agentSupervisor.executeAgentSupervised(
    workerInstance,
    sessionContext.payload,
    testTask,
    supervision,
  );

  assertExists(result);
  assertEquals(result.agent_id, testAgent.id);
  assertExists(result.output);
  assertExists(result.execution_metadata);

  // Test 5: Worker cleanup
  await agentSupervisor.terminateWorker(workerInstance.id);

  // Test 6: Health monitoring
  const healthStatus = agentSupervisor.getHealthStatus();
  assertExists(healthStatus);
  assertEquals(healthStatus.active_workers, 0);
});

Deno.test("AgentSupervisor - Worker Lifecycle Management", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const supervisorConfig = {
    model: "claude-4-sonnet-20250514",
    prompts: { system: "Test supervisor" },
    memoryConfig: {
      default: {
        enabled: true,
        storage: "coala-local",
        cognitive_loop: true,
        retention: {
          max_age_days: 30,
          max_entries: 1000,
          cleanup_interval_hours: 24,
        },
      },
      agent: {
        enabled: true,
        scope: "agent" as const,
        include_in_context: true,
        context_limits: {
          relevant_memories: 10,
          past_successes: 5,
          past_failures: 5,
        },
        memory_types: {
          contextual: { enabled: true, max_entries: 100 },
          episodic: { enabled: true, max_entries: 50 },
          semantic: { enabled: true, max_entries: 200 },
        },
      },
      session: {
        enabled: true,
        scope: "session" as const,
        include_in_context: true,
        context_limits: {
          relevant_memories: 15,
          past_successes: 10,
          past_failures: 10,
        },
        memory_types: {
          contextual: { enabled: true, max_entries: 200 },
          episodic: { enabled: true, max_entries: 100 },
          semantic: { enabled: true, max_entries: 300 },
        },
      },
      workspace: {
        enabled: true,
        scope: "workspace" as const,
        include_in_context: true,
        context_limits: {
          relevant_memories: 20,
          past_successes: 15,
          past_failures: 15,
        },
        memory_types: {
          contextual: { enabled: true, max_entries: 500 },
          episodic: { enabled: true, max_entries: 200 },
          semantic: { enabled: true, max_entries: 1000 },
        },
      },
    },
  };

  const supervisor = new AgentSupervisor(supervisorConfig);

  // Test worker metrics
  const metrics = supervisor.getWorkerMetrics();
  assertEquals(typeof metrics, "object");

  // Test worker monitoring
  const monitoring = await supervisor.monitorWorkers();
  assertExists(monitoring);
  assertEquals(monitoring.healthy, 0);
  assertEquals(monitoring.idle, 0);
  assertEquals(monitoring.busy, 0);

  // Test cleanup (should handle empty case)
  const cleanedUp = await supervisor.cleanupIdleWorkers(0);
  assertEquals(cleanedUp, 0);
});
