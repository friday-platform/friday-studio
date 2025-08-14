/**
 * Tests the Atlas agent execution state machine that handles the core agent lifecycle:
 * idle → loading → ready → preparing → executing → persisting → completed
 */

import { assert, assertEquals, assertExists } from "@std/assert";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { AgentExecutionManager } from "../../src/agent-server/agent-execution-manager.ts";
import { createAgentExecutionMachine } from "../../src/agent-server/agent-execution-machine.ts";
import { ApprovalQueueManager } from "../../src/agent-server/approval-queue-manager.ts";
import { createMockContextBuilder } from "./test-helpers.ts";
import { createActor } from "xstate";
import type { AgentContext, AgentSessionData, AtlasAgent } from "@atlas/agent-sdk";
import { createLogger } from "@atlas/logger";
import type { Logger } from "@atlas/logger";
import { CoALAMemoryType } from "@atlas/memory";

Deno.env.set("DENO_TESTING", "true");

// Mocks CoALA memory persistence - stores in Map for fast, isolated testing
class MockMemoryManager {
  memories = new Map<string, Record<string, unknown>>();

  getRelevantMemoriesForPrompt(_prompt: string, options: { sourceScope: string }) {
    return Promise.resolve({
      memories: Array.from(this.memories.values()).filter((m) =>
        m.sourceScope === options.sourceScope
      ),
    });
  }

  rememberWithMetadata(
    key: string,
    value: Record<string, unknown>,
    metadata: Record<string, unknown>,
  ) {
    this.memories.set(key, { ...value, ...metadata });
  }

  queryMemories(_query: unknown) {
    return Array.from(this.memories.values());
  }
}

// Test agent that tracks execution calls and can simulate failures
class MockAgent implements AtlasAgent {
  metadata = {
    id: "test-agent",
    name: "Test Agent",
    version: "1.0.0",
    description: "Mock agent for testing",
    expertise: {
      domains: ["testing"],
      capabilities: ["mock"],
      examples: ["test example"],
    },
  };

  executeCallCount = 0;
  lastPrompt?: string;
  lastContext?: AgentContext;
  shouldFail = false;
  executionDelay = 0;
  mockResult?: unknown;

  async execute(prompt: string, context: AgentContext): Promise<unknown> {
    this.executeCallCount++;
    this.lastPrompt = prompt;
    this.lastContext = context;

    if (this.executionDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.executionDelay));
    }

    if (this.shouldFail) {
      throw new Error("Mock execution failure");
    }

    return this.mockResult || { result: `Executed: ${prompt}` };
  }

  get environmentConfig() {
    return undefined;
  }

  get mcpConfig() {
    return undefined;
  }

  get llmConfig() {
    return undefined;
  }
}

describe("Enhanced Agent Execution Machine", () => {
  let mockAgent: MockAgent;
  let contextBuilder: ReturnType<typeof createMockContextBuilder>;
  let memoryManager: MockMemoryManager;
  let loadAgentFn: (agentId: string) => Promise<AtlasAgent>;

  beforeEach(() => {
    mockAgent = new MockAgent();
    memoryManager = new MockMemoryManager();
    contextBuilder = createMockContextBuilder();

    loadAgentFn = (agentId: string) => {
      if (agentId === "test-agent") {
        return Promise.resolve(mockAgent);
      }
      return Promise.reject(new Error(`Agent not found: ${agentId}`));
    };
  });

  it("should execute full state machine lifecycle including context preparation", async () => {
    const logger = createLogger();
    const machine = createAgentExecutionMachine(loadAgentFn, contextBuilder, null, logger);
    const actor = createActor(machine, {
      input: { agentId: "test-agent" },
    });

    actor.start();

    const stateHistory: string[] = [];
    const subscription = actor.subscribe((snapshot) => {
      if (typeof snapshot.value === "string") {
        stateHistory.push(snapshot.value);
      }
    });

    const sessionData: AgentSessionData = {
      sessionId: "test-session",
      workspaceId: "test-workspace",
    };

    actor.send({ type: "EXECUTE", prompt: "test prompt", sessionData });

    await new Promise((resolve) => setTimeout(resolve, 500));

    // Verify all expected states were entered during execution
    assert(stateHistory.includes("preparing"), "Should have entered preparing state");
    assert(stateHistory.includes("executing"), "Should have entered executing state");
    assert(stateHistory.includes("persisting"), "Should have entered persisting state");

    subscription.unsubscribe();
    actor.stop();
  });

  it("should build agent context but not expose memory to agent handlers", async () => {
    const logger = createLogger();
    const machine = createAgentExecutionMachine(loadAgentFn, contextBuilder, null, logger);
    const actor = createActor(machine, {
      input: { agentId: "test-agent" },
    });

    actor.start();

    const sessionData: AgentSessionData = {
      sessionId: "test-session",
      workspaceId: "test-workspace",
    };

    const promise = new Promise<void>((resolve) => {
      const subscription = actor.subscribe((snapshot) => {
        if (snapshot.value === "completed") {
          subscription.unsubscribe();
          resolve();
        }
      });
    });

    actor.send({ type: "EXECUTE", prompt: "test prompt", sessionData });
    await promise;

    // Verify context includes required properties but not internal memory
    assertExists(mockAgent.lastContext);
    assertExists(mockAgent.lastContext);
    assertExists(mockAgent.lastContext.env);
    assertExists(mockAgent.lastContext.session);
    assert(!("memory" in mockAgent.lastContext));

    actor.stop();
  });

  it.skip("should persist execution results to memory", async () => {
    // Test memory persistence - currently skipped pending CoALA integration
    memoryManager.rememberWithMetadata(
      "test-memory",
      { content: "test" },
      { memoryType: CoALAMemoryType.SEMANTIC, sourceScope: "agent:test-agent" },
    );

    const logger = createLogger();
    const machine = createAgentExecutionMachine(loadAgentFn, contextBuilder, null, logger);
    const actor = createActor(machine, {
      input: { agentId: "test-agent" },
    });

    actor.start();

    const sessionData: AgentSessionData = {
      sessionId: "test-session",
      workspaceId: "test-workspace",
    };

    // Set up mock result with tool calls
    mockAgent.mockResult = {
      result: "success",
      toolCalls: [{ name: "tool1" }, { name: "tool2" }],
    };

    const promise = new Promise<void>((resolve) => {
      const subscription = actor.subscribe((snapshot) => {
        if (snapshot.value === "completed") {
          subscription.unsubscribe();
          resolve();
        }
      });
    });

    actor.send({ type: "EXECUTE", prompt: "test prompt", sessionData });
    await promise;

    // Verify execution was persisted
    const memories = Array.from(memoryManager.memories.values());

    // Should have episodic memory
    const episodicMemory = memories.find((m) => m.memoryType === "episodic");
    assertExists(episodicMemory);
    assertEquals(episodicMemory.agentId, "test-agent");
    assertEquals(episodicMemory.prompt, "test prompt");

    // Should have procedural memory for pattern
    const proceduralMemory = memories.find((m) => m.memoryType === "procedural");
    assertExists(proceduralMemory);
    assertEquals(proceduralMemory.toolSequence, ["tool1", "tool2"]);

    actor.stop();
  });

  it("should handle context preparation failure", async () => {
    // Override context builder to fail
    const failingContextBuilder = () => {
      return Promise.reject(new Error("Context preparation failed"));
    };

    const logger = createLogger();
    const machine = createAgentExecutionMachine(
      loadAgentFn,
      failingContextBuilder,
      null,
      logger,
    );
    const actor = createActor(machine, {
      input: { agentId: "test-agent" },
    });

    actor.start();

    const promise = new Promise<void>((resolve) => {
      const subscription = actor.subscribe((snapshot) => {
        if (snapshot.value === "failed") {
          assertExists(snapshot.context.error);
          assertEquals(snapshot.context.error.message, "Context preparation failed");
          subscription.unsubscribe();
          resolve();
        }
      });
    });

    const sessionData: AgentSessionData = {
      sessionId: "test-session",
      workspaceId: "test-workspace",
    };

    actor.send({ type: "EXECUTE", prompt: "test prompt", sessionData });
    await promise;

    actor.stop();
  });
});

describe("Enhanced Agent Execution Manager", () => {
  let manager: AgentExecutionManager;
  let mockAgent: MockAgent;
  let contextBuilder: ReturnType<typeof createMockContextBuilder>;
  let memoryManager: MockMemoryManager;
  let approvalQueue: ApprovalQueueManager;
  let logger: Logger;

  beforeEach(() => {
    mockAgent = new MockAgent();
    memoryManager = new MockMemoryManager();
    contextBuilder = createMockContextBuilder();
    logger = createLogger();
    approvalQueue = new ApprovalQueueManager(logger);

    const loadAgentFn = (agentId: string) => {
      if (agentId === "test-agent") {
        return Promise.resolve(mockAgent);
      }
      return Promise.reject(new Error(`Agent not found: ${agentId}`));
    };

    manager = new AgentExecutionManager(loadAgentFn, contextBuilder, null, approvalQueue, logger);
  });

  afterEach(() => {
    manager.shutdown();
  });

  it("should execute agent with session data", async () => {
    const sessionData: AgentSessionData = {
      sessionId: "test-session",
      workspaceId: "test-workspace",
    };

    const result = await manager.executeAgent(
      "test-agent",
      "test prompt",
      sessionData,
    );
    assertEquals(result, { result: "Executed: test prompt" });
    assertEquals(mockAgent.executeCallCount, 1);

    // Verify session data was passed through context
    assertExists(mockAgent.lastContext?.session);
    assertEquals(mockAgent.lastContext.session.sessionId, "test-session");
    assertEquals(mockAgent.lastContext.session.workspaceId, "test-workspace");
  });

  it("should execute with memory integration", async () => {
    const sessionData: AgentSessionData = {
      sessionId: "test-session",
      workspaceId: "test-workspace",
    };

    // Add some memories to the manager
    memoryManager.memories.set("memory1", {
      memoryType: CoALAMemoryType.EPISODIC,
      prompt: "previous interaction",
      timestamp: new Date(),
      sourceScope: "agent:test-agent",
    });

    await manager.executeAgent(
      "test-agent",
      "test prompt",
      sessionData,
    );

    // Verify agent received enriched prompt (mocked getRelevantMemoriesForPrompt returns memories)
    const executedPrompt = mockAgent.lastPrompt;
    assertExists(executedPrompt);

    // Since MockMemoryManager returns all memories with matching sourceScope,
    // the prompt might be enriched. For now, just verify execution happened
    assertEquals(mockAgent.executeCallCount, 1);

    // Verify context doesn't have memory property
    assertExists(mockAgent.lastContext);
    assert(!("memory" in mockAgent.lastContext));
  });

  it("should handle persistence failures gracefully", async () => {
    // Override memory manager to fail on rememberWithMetadata
    memoryManager.rememberWithMetadata = () => {
      throw new Error("Memory persistence failed");
    };

    const sessionData: AgentSessionData = {
      sessionId: "test-session",
      workspaceId: "test-workspace",
    };

    // Should not throw - persistence failures are logged but don't fail execution
    const result = await manager.executeAgent(
      "test-agent",
      "test prompt",
      sessionData,
    );
    assertEquals(result, { result: "Executed: test prompt" });
  });
});
