import { assertEquals, assertStringIncludes } from "@std/assert";
import { SessionSupervisor } from "../../src/core/session-supervisor.ts";
import type {
  AgentMetadata,
  JobAgentSpec,
  JobSpecification,
  SessionContext,
} from "../../src/core/session-supervisor.ts";
import type { AtlasMemoryConfig } from "../../src/core/memory-config.ts";

// Mock LLM response for testing
const mockLLMResponse =
  "Clean task: Monitor the pod scheduling event and verify successful deployment.";

// Helper to create test memory config
function createTestMemoryConfig(): AtlasMemoryConfig {
  return {
    default: {
      enabled: true,
      storage: "memory",
      cognitive_loop: false,
      retention: { max_age_days: 1, max_entries: 10, cleanup_interval_hours: 1 },
    },
    agent: {
      enabled: true,
      scope: "agent",
      include_in_context: true,
      context_limits: { relevant_memories: 10, past_successes: 5, past_failures: 5 },
      memory_types: { contextual: { enabled: true, max_entries: 100 } },
    },
    session: {
      enabled: true,
      scope: "session",
      include_in_context: true,
      context_limits: { relevant_memories: 15, past_successes: 10, past_failures: 10 },
      memory_types: { contextual: { enabled: true, max_entries: 200 } },
    },
    workspace: {
      enabled: true,
      scope: "workspace",
      include_in_context: true,
      context_limits: { relevant_memories: 20, past_successes: 15, past_failures: 15 },
      memory_types: { contextual: { enabled: true, max_entries: 500 } },
    },
  };
}

// Helper to create test session context
function createTestSessionContext(): SessionContext {
  // Create a minimal mock signal that satisfies the interface
  const mockSignal = {
    id: "test-signal",
    provider: { id: "test", name: "test-provider" },
    // Mock the required IAtlasScope properties
    parentScopeId: undefined,
    supervisor: undefined,
    context: {} as any,
    memory: {} as any,
    messages: {} as any,
    prompts: { system: "", user: "" },
    gates: [],
    newConversation: () => ({} as any),
    getConversation: () => ({} as any),
    archiveConversation: () => {},
    deleteConversation: () => {},
    trigger: async () => {},
    configure: () => {},
  };

  return {
    sessionId: "test-session-123",
    workspaceId: "test-workspace",
    signal: mockSignal as any,
    payload: {
      event: {
        type: "Normal",
        reason: "Scheduled",
        message: "Pod scheduled successfully",
        involvedObject: { kind: "Pod", name: "test-pod" },
        namespace: "default",
      },
      metadata: { uid: "abc-123", timestamp: "2025-01-01T00:00:00Z" },
    },
    availableAgents: [
      {
        id: "remote-agent",
        type: "remote",
        purpose: "Execute operations via remote protocol",
        config: { protocol: "acp", tools: ["kubectl"] },
      },
      {
        id: "llm-agent",
        type: "llm",
        purpose: "Analysis and documentation",
        config: { tools: ["computer_use"] },
      },
    ] as AgentMetadata[],
    filteredMemory: [],
    constraints: {},
    jobSpec: undefined,
  };
}

Deno.test({
  name: "SessionSupervisor - Intelligent Task Preparation",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    await t.step("should use explicit agent prompt when provided", async () => {
      const supervisor = new SessionSupervisor(createTestMemoryConfig());
      const sessionContext = createTestSessionContext();
      await supervisor.initializeSession(sessionContext);

      const agentSpec: JobAgentSpec = {
        id: "test-agent",
        prompt: "Execute this specific custom task",
      };

      const jobSpec: JobSpecification = {
        name: "test-job",
        description: "Test job description",
        execution: { strategy: "sequential", agents: [agentSpec] },
      };

      // This should return the explicit prompt without LLM call
      const task = await (supervisor as any).prepareTaskForAgent(
        agentSpec,
        jobSpec,
        sessionContext.payload,
        sessionContext,
      );

      assertEquals(task, "Execute this specific custom task");
    });

    await t.step("should use job task_template when provided and no agent prompt", async () => {
      const supervisor = new SessionSupervisor(createTestMemoryConfig());
      const sessionContext = createTestSessionContext();
      await supervisor.initializeSession(sessionContext);

      const agentSpec: JobAgentSpec = {
        id: "test-agent",
      };

      const jobSpec: JobSpecification = {
        name: "test-job",
        description: "Test job description",
        task_template: "Process the signal data according to template",
        execution: { strategy: "sequential", agents: [agentSpec] },
      };

      const task = await (supervisor as any).prepareTaskForAgent(
        agentSpec,
        jobSpec,
        sessionContext.payload,
        sessionContext,
      );

      assertEquals(task, "Process the signal data according to template");
    });

    await t.step(
      "should generate intelligent task when no explicit prompt or template",
      async () => {
        const supervisor = new SessionSupervisor(createTestMemoryConfig());
        const sessionContext = createTestSessionContext();
        await supervisor.initializeSession(sessionContext);

        // Mock the LLM call
        (supervisor as any).generateLLM = async () => mockLLMResponse;

        const agentSpec: JobAgentSpec = {
          id: "remote-agent",
        };

        const jobSpec: JobSpecification = {
          name: "event-handler",
          description: "Handle incoming events",
          execution: { strategy: "sequential", agents: [agentSpec] },
        };

        const task = await (supervisor as any).prepareTaskForAgent(
          agentSpec,
          jobSpec,
          sessionContext.payload,
          sessionContext,
        );

        assertEquals(task, mockLLMResponse);
      },
    );

    await t.step("should include agent capabilities in LLM prompt", async () => {
      const supervisor = new SessionSupervisor(createTestMemoryConfig());
      const sessionContext = createTestSessionContext();
      await supervisor.initializeSession(sessionContext);

      let capturedPrompt = "";
      (supervisor as any).generateLLM = async (
        _model: string,
        _systemPrompt: string,
        userPrompt: string,
      ) => {
        capturedPrompt = userPrompt;
        return mockLLMResponse;
      };

      const agentSpec: JobAgentSpec = {
        id: "remote-agent",
      };

      const jobSpec: JobSpecification = {
        name: "test-job",
        description: "Test description",
        execution: { strategy: "sequential", agents: [agentSpec] },
      };

      await (supervisor as any).prepareTaskForAgent(
        agentSpec,
        jobSpec,
        sessionContext.payload,
        sessionContext,
      );

      // Verify agent capabilities are included in prompt
      assertStringIncludes(capturedPrompt, "**Target Agent**: remote-agent");
      assertStringIncludes(capturedPrompt, "Execute operations via remote protocol");
    });

    await t.step("should remove noise from signal data in LLM prompt", async () => {
      const supervisor = new SessionSupervisor(createTestMemoryConfig());
      const sessionContext = createTestSessionContext();
      await supervisor.initializeSession(sessionContext);

      let capturedPrompt = "";
      (supervisor as any).generateLLM = async (
        _model: string,
        _systemPrompt: string,
        userPrompt: string,
      ) => {
        capturedPrompt = userPrompt;
        return mockLLMResponse;
      };

      const agentSpec: JobAgentSpec = {
        id: "test-agent",
      };

      const jobSpec: JobSpecification = {
        name: "test-job",
        description: "Test description",
        execution: { strategy: "sequential", agents: [agentSpec] },
      };

      await (supervisor as any).prepareTaskForAgent(
        agentSpec,
        jobSpec,
        sessionContext.payload,
        sessionContext,
      );

      // Verify the signal data is included for analysis
      assertStringIncludes(capturedPrompt, "**Raw Data Summary**");
      assertStringIncludes(capturedPrompt, "Event Type");
      assertStringIncludes(capturedPrompt, "CRITICAL INSTRUCTIONS");
    });

    await t.step(
      "should generate different capabilities description for different agent types",
      () => {
        const supervisor = new SessionSupervisor(createTestMemoryConfig());
        const sessionContext = createTestSessionContext();

        // Test remote agent capabilities
        const remoteCapabilities = (supervisor as any).getAgentCapabilitiesDescription(
          "remote-agent",
          sessionContext.availableAgents,
        );
        assertStringIncludes(remoteCapabilities, "Agent Type: remote");
        assertStringIncludes(remoteCapabilities, "Execute operations via remote protocol");

        // Test LLM agent capabilities
        const llmCapabilities = (supervisor as any).getAgentCapabilitiesDescription(
          "llm-agent",
          sessionContext.availableAgents,
        );
        assertStringIncludes(llmCapabilities, "Agent Type: llm");
        assertStringIncludes(llmCapabilities, "Analysis and documentation");
      },
    );

    await t.step("should handle unknown agent gracefully", () => {
      const supervisor = new SessionSupervisor(createTestMemoryConfig());
      const sessionContext = createTestSessionContext();

      const capabilities = (supervisor as any).getAgentCapabilitiesDescription(
        "unknown-agent",
        sessionContext.availableAgents,
      );

      assertEquals(capabilities, "Unknown agent capabilities");
    });

    await t.step("should include workspace-agnostic preparation instructions", async () => {
      const supervisor = new SessionSupervisor(createTestMemoryConfig());
      const sessionContext = createTestSessionContext();
      await supervisor.initializeSession(sessionContext);

      let capturedSystemPrompt = "";
      (supervisor as any).generateLLM = async (
        _model: string,
        systemPrompt: string,
        _userPrompt: string,
      ) => {
        capturedSystemPrompt = systemPrompt;
        return mockLLMResponse;
      };

      const agentSpec: JobAgentSpec = { id: "test-agent" };
      const jobSpec: JobSpecification = {
        name: "test-job",
        description: "Test description",
        execution: { strategy: "sequential", agents: [agentSpec] },
      };

      await (supervisor as any).prepareTaskForAgent(
        agentSpec,
        jobSpec,
        sessionContext.payload,
        sessionContext,
      );

      // Verify system prompt is workspace-agnostic
      assertStringIncludes(capturedSystemPrompt, "intelligent task preparation assistant");
      // Should not contain k8s-specific terms
      assertEquals(capturedSystemPrompt.includes("kubernetes"), false);
      assertEquals(capturedSystemPrompt.includes("kubectl"), false);
    });
  },
});
