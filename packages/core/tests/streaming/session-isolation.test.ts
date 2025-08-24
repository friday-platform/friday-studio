import type { AgentContext } from "@atlas/agent-sdk";
import { createLogger } from "@atlas/logger";
import { assertEquals } from "@std/assert";
import { assertSpyCall, assertSpyCalls, spy } from "@std/testing/mock";
import {
  type AgentExecutionContext,
  AgentOrchestrator,
} from "../../src/orchestrator/agent-orchestrator.ts";

/**
 * Tests session isolation - the most critical aspect of Atlas streaming.
 *
 * ATLAS ARCHITECTURE CONTEXT:
 * Sessions represent individual execution contexts within a workspace. Multiple
 * sessions can run concurrently, potentially using the same MCP client infrastructure.
 * The AgentOrchestrator maintains activeStreamHandlers map with composite keys
 * (sessionId:agentId) to route events correctly.
 *
 * CRITICAL INVARIANT:
 * Events from one session must NEVER leak to another session, even when:
 * - Sessions share the same MCP client
 * - Sessions execute the same agent
 * - Sessions run in the same workspace
 *
 * TESTING STRATEGY:
 * - Uses spy functions to track exact event delivery
 * - MOCK agents emit session-specific events
 * - Tests REAL AgentOrchestrator session routing logic
 * - Verifies handler cleanup to prevent memory leaks
 */
Deno.test("Session Isolation with Shared MCP Client", async (t) => {
  await t.step("should properly isolate stream events between concurrent sessions", async () => {
    const config = { agentsServerUrl: "http://localhost:8081/mcp", executionTimeout: 10000 };
    const logger = createLogger({ level: "error" });
    const orchestrator = new AgentOrchestrator(config, logger);
    orchestrator.initialize();

    // Spy functions track exact event delivery
    const session1Handler = spy();
    const session2Handler = spy();

    // Two sessions in same workspace, different stream handlers
    const session1: AgentExecutionContext = {
      sessionId: "session-1",
      workspaceId: "workspace-1",
      streamId: "stream-1",
      onStreamEvent: session1Handler,
    };
    const session2: AgentExecutionContext = {
      sessionId: "session-2",
      workspaceId: "workspace-1",
      streamId: "stream-2",
      onStreamEvent: session2Handler,
    };

    // MOCK: Agent that includes session ID in events for verification
    const mockAgent = {
      metadata: {
        id: "test-agent",
        version: "1.0.0",
        description: "",
        displayName: "Test Agent",
        expertise: {
          domains: ["testing"],
          capabilities: ["basic execution"],
          examples: ["run test task"],
        },
      },
      execute: (_prompt: string, context: AgentContext) => {
        // Embeds session ID to verify correct routing
        context.stream.emit({
          type: "text",
          content: `Session ${context.session.sessionId} event`,
        });
        return Promise.resolve({ result: "done" });
      },
      environmentConfig: undefined,
      mcpConfig: undefined,
      llmConfig: undefined,
    };
    orchestrator.registerWrappedAgent("test-agent", mockAgent);

    // Execute same agent concurrently in both sessions
    const promise1 = orchestrator.executeAgent("test-agent", "task", session1);
    const promise2 = orchestrator.executeAgent("test-agent", "task", session2);

    await Promise.all([promise1, promise2]);

    // KEY TEST: Each handler called exactly once with correct event
    assertSpyCalls(session1Handler, 1);
    assertSpyCall(session1Handler, 0, {
      args: [{ type: "text", content: "Session session-1 event" }],
    });

    assertSpyCalls(session2Handler, 1);
    assertSpyCall(session2Handler, 0, {
      args: [{ type: "text", content: "Session session-2 event" }],
    });

    await orchestrator.shutdown();
  });

  await t.step("should handle rapid session creation/destruction without leaks", async () => {
    /**
     * Memory leak test: Verifies activeStreamHandlers cleanup.
     * Without proper cleanup, handler references would accumulate.
     */
    const config = { agentsServerUrl: "http://localhost:8081/mcp", executionTimeout: 10000 };
    const logger = createLogger({ level: "error" });
    const orchestrator = new AgentOrchestrator(config, logger);
    orchestrator.initialize();

    // MOCK: Simple agent for rapid execution
    const mockAgent = {
      metadata: {
        id: "agent",
        version: "1.0.0",
        description: "",
        displayName: "Test Agent",
        expertise: {
          domains: ["testing"],
          capabilities: ["basic execution"],
          examples: ["run test task"],
        },
      },
      execute: () => Promise.resolve({ result: "done" }),
      environmentConfig: undefined,
      mcpConfig: undefined,
      llmConfig: undefined,
    };
    orchestrator.registerWrappedAgent("agent", mockAgent);

    // Stress test: 100 rapid session create/destroy cycles
    for (let i = 0; i < 100; i++) {
      const sessionId = `session-${i}`;
      const handler = spy();

      await orchestrator.executeAgent("agent", "task", {
        sessionId,
        workspaceId: "workspace-1",
        onStreamEvent: handler,
      });

      // Verify handler cleanup after execution
      // Note: Accessing private field for leak detection test
      assertEquals(
        (
          orchestrator as unknown as { activeStreamHandlers: Map<string, unknown> }
        ).activeStreamHandlers.has(`${sessionId}:agent`),
        false,
      );
    }

    // KEY TEST: All handlers cleaned up, no memory leak
    // Note: Accessing private field for leak detection test
    assertEquals(
      (orchestrator as unknown as { activeStreamHandlers: Map<string, unknown> })
        .activeStreamHandlers.size,
      0,
    );

    await orchestrator.shutdown();
  });

  await t.step("should handle MCP notification isolation with multiple agents", async () => {
    /**
     * Complex scenario: Multiple agents in multiple sessions.
     * Tests the composite key routing (sessionId:agentId).
     */
    const config = { agentsServerUrl: "http://localhost:8081/mcp", executionTimeout: 10000 };
    const logger = createLogger({ level: "error" });
    const orchestrator = new AgentOrchestrator(config, logger);
    orchestrator.initialize();

    // 4 handlers for 2×2 matrix of session×agent combinations
    const session1Agent1Handler = spy();
    const session1Agent2Handler = spy();
    const session2Agent1Handler = spy();
    const session2Agent2Handler = spy();
    const session1 = { sessionId: "session-1", workspaceId: "workspace-1", streamId: "stream-1" };
    const session2 = { sessionId: "session-2", workspaceId: "workspace-1", streamId: "stream-2" };

    // MOCK: Two different agents that identify themselves in events
    ["agent-1", "agent-2"].forEach((agentId) => {
      orchestrator.registerWrappedAgent(agentId, {
        metadata: {
          id: agentId,
          version: "1.0.0",
          description: "",
          displayName: `Test ${agentId}`,
          expertise: {
            domains: ["testing"],
            capabilities: ["basic execution"],
            examples: ["run test task"],
          },
        },
        execute: (_prompt: string, context: AgentContext) => {
          context.stream.emit({
            type: "text",
            content: `Event from ${agentId} in session ${context.session.sessionId}`,
          });
          return Promise.resolve({ result: "done" });
        },
        environmentConfig: undefined,
        mcpConfig: undefined,
        llmConfig: undefined,
      });
    });

    // Execute 2×2 matrix: 2 agents × 2 sessions = 4 executions
    await Promise.all([
      orchestrator.executeAgent("agent-1", "task", {
        ...session1,
        onStreamEvent: session1Agent1Handler,
      }),
      orchestrator.executeAgent("agent-2", "task", {
        ...session1,
        onStreamEvent: session1Agent2Handler,
      }),
      orchestrator.executeAgent("agent-1", "task", {
        ...session2,
        onStreamEvent: session2Agent1Handler,
      }),
      orchestrator.executeAgent("agent-2", "task", {
        ...session2,
        onStreamEvent: session2Agent2Handler,
      }),
    ]);

    // KEY TEST: Each of 4 handlers receives exactly its own event
    assertSpyCalls(session1Agent1Handler, 1);
    assertSpyCall(session1Agent1Handler, 0, {
      args: [{ type: "text", content: "Event from agent-1 in session session-1" }],
    });

    assertSpyCalls(session1Agent2Handler, 1);
    assertSpyCall(session1Agent2Handler, 0, {
      args: [{ type: "text", content: "Event from agent-2 in session session-1" }],
    });

    assertSpyCalls(session2Agent1Handler, 1);
    assertSpyCall(session2Agent1Handler, 0, {
      args: [{ type: "text", content: "Event from agent-1 in session session-2" }],
    });

    assertSpyCalls(session2Agent2Handler, 1);
    assertSpyCall(session2Agent2Handler, 0, {
      args: [{ type: "text", content: "Event from agent-2 in session session-2" }],
    });

    await orchestrator.shutdown();
  });
});
