import { assertEquals, assertNotEquals } from "@std/assert";
import {
  AgentExecutionContext,
  AgentOrchestrator,
} from "../../src/orchestrator/agent-orchestrator.ts";
import type { AgentContext, StreamEvent } from "@atlas/agent-sdk";
import { createLogger } from "@atlas/logger";

/**
 * Tests workspace isolation in Atlas streaming architecture.
 *
 * ATLAS ARCHITECTURE CONTEXT:
 * Atlas supports multiple workspaces running agents concurrently. Each workspace
 * is an isolated environment with its own configuration, agents, and execution context.
 * Stream events must never leak between workspaces, even when:
 * - Same session IDs are used in different workspaces
 * - Same agents execute in multiple workspaces simultaneously
 * - Workspaces share the same AgentOrchestrator instance
 *
 * TESTING STRATEGY:
 * - Uses MOCK agents that emit workspace-specific events
 * - Tests REAL AgentOrchestrator workspace isolation mechanisms
 * - Verifies stream handler routing by workspace+session composite keys
 * - Stress tests concurrent execution across multiple workspaces
 */
Deno.test("Multi-Workspace Streaming", async (t) => {
  await t.step("should isolate streams between different workspaces", async () => {
    /**
     * Core test: Verifies workspace isolation with same session IDs.
     * This can happen when different teams use similar naming conventions.
     */
    const config = {
      agentsServerUrl: "http://localhost:8081/mcp",
      executionTimeout: 10000,
    };
    const logger = createLogger({ level: "error" });
    const orchestrator = new AgentOrchestrator(config, logger);
    orchestrator.initialize();

    // Track events for each workspace separately
    const ws1Events: StreamEvent[] = [];
    const ws2Events: StreamEvent[] = [];

    // KEY TEST SETUP: Same session ID in different workspaces
    const workspace1: AgentExecutionContext = {
      workspaceId: "ws-1",
      sessionId: "session-1",
      streamId: "stream-1",
      onStreamEvent: (event: StreamEvent) => ws1Events.push(event),
    };
    const workspace2: AgentExecutionContext = {
      workspaceId: "ws-2",
      sessionId: "session-1", // Intentionally same session ID
      streamId: "stream-2",
      onStreamEvent: (event: StreamEvent) => ws2Events.push(event),
    };

    // MOCK: Agent that embeds workspace ID in events
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
      execute: (_prompt: string, context: AgentContext) => {
        context.stream.emit({
          type: "text",
          content: `Event from workspace ${context.session.workspaceId}`,
        });
        return Promise.resolve({ result: "done" });
      },
      environmentConfig: undefined,
      mcpConfig: undefined,
      llmConfig: undefined,
    };
    orchestrator.registerWrappedAgent("agent", mockAgent);

    // Execute same agent in both workspaces concurrently
    await Promise.all([
      orchestrator.executeAgent("agent", "task", workspace1),
      orchestrator.executeAgent("agent", "task", workspace2),
    ]);

    // KEY TEST: Events properly isolated despite same sessionId
    assertEquals(ws1Events.length, 1);
    assertEquals(ws2Events.length, 1);
    assertNotEquals(ws1Events[0], ws2Events[0]);
    if (ws1Events[0].type === "text") {
      assertEquals(ws1Events[0].content, "Event from workspace ws-1");
    }
    if (ws2Events[0].type === "text") {
      assertEquals(ws2Events[0].content, "Event from workspace ws-2");
    }

    await orchestrator.shutdown();
  });

  await t.step("should handle concurrent workspace executions with same agent", async () => {
    /**
     * Stress test: Multiple workspaces executing the same agent concurrently.
     * Tests that execution order doesn't affect isolation.
     */
    const config = {
      agentsServerUrl: "http://localhost:8081/mcp",
      executionTimeout: 10000,
    };
    const logger = createLogger({ level: "error" });
    const orchestrator = new AgentOrchestrator(config, logger);
    orchestrator.initialize();

    // Track all events to verify no cross-contamination
    const executionLog: Array<{ workspace: string; event: string }> = [];

    // Create 5 workspaces with unique IDs
    const workspaces = ["ws-1", "ws-2", "ws-3", "ws-4", "ws-5"];
    const contexts: AgentExecutionContext[] = workspaces.map((wsId, index) => ({
      workspaceId: wsId,
      sessionId: `session-${index}`,
      streamId: `stream-${index}`,
      onStreamEvent: (event: StreamEvent) => {
        if (event.type === "text") {
          executionLog.push({
            workspace: wsId,
            event: event.content,
          });
        }
      },
    }));

    // MOCK: Agent with random delays to test race conditions
    const mockAgent = {
      metadata: {
        id: "slow-agent",
        version: "1.0.0",
        description: "",
        displayName: "Slow Test Agent",
        expertise: {
          domains: ["testing"],
          capabilities: ["basic execution"],
          examples: ["run test task"],
        },
      },
      execute: async (_prompt: string, context: AgentContext) => {
        context.stream.emit({
          type: "text",
          content: `Starting in ${context.session.workspaceId}`,
        });

        // Random delay tests concurrent execution paths
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 100));
        context.stream.emit({
          type: "text",
          content: `Completed in ${context.session.workspaceId}`,
        });

        return { result: `Result from ${context.session.workspaceId}` };
      },
      environmentConfig: undefined,
      mcpConfig: undefined,
      llmConfig: undefined,
    };
    orchestrator.registerWrappedAgent("slow-agent", mockAgent);

    // Execute all 5 workspaces concurrently
    const results = await Promise.all(
      contexts.map((ctx) => orchestrator.executeAgent("slow-agent", "concurrent task", ctx)),
    );

    // All executions complete successfully
    assertEquals(results.length, 5);
    results.forEach((result, index) => {
      assertEquals(result.output.result, `Result from ws-${index + 1}`);
    });

    // KEY TEST: Each workspace received only its own events
    for (const wsId of workspaces) {
      const wsEvents = executionLog.filter((log) => log.workspace === wsId);
      assertEquals(wsEvents.length, 2); // Exactly 2 events per workspace
      assertEquals(wsEvents[0].event, `Starting in ${wsId}`);
      assertEquals(wsEvents[1].event, `Completed in ${wsId}`);
    }

    // KEY TEST: Total event count proves no duplication or loss
    const totalEvents = executionLog.length;
    assertEquals(totalEvents, 10); // 5 workspaces × 2 events = 10 total

    await orchestrator.shutdown();
  });

  await t.step("should handle workspace-specific stream handlers", async () => {
    /**
     * Tests different handler behaviors per workspace.
     * Each workspace processes stream events differently based on its needs.
     */
    const config = {
      agentsServerUrl: "http://localhost:8081/mcp",
      executionTimeout: 10000,
    };
    const logger = createLogger({ level: "error" });
    const orchestrator = new AgentOrchestrator(config, logger);
    orchestrator.initialize();

    // Each workspace has different processing logic
    let ws1Count = 0; // Counts progress events
    let ws2Sum = 0; // Sums progress percentages
    const ws3Events: string[] = []; // Logs text events

    const workspace1: AgentExecutionContext = {
      workspaceId: "counter-ws",
      sessionId: "session-1",
      streamId: "stream-1",
      onStreamEvent: (event: StreamEvent) => {
        if (event.type === "progress") {
          ws1Count++;
        }
      },
    };

    const workspace2: AgentExecutionContext = {
      workspaceId: "sum-ws",
      sessionId: "session-2",
      streamId: "stream-2",
      onStreamEvent: (event: StreamEvent) => {
        if (event.type === "progress" && event.percentage !== undefined) {
          ws2Sum += event.percentage;
        }
      },
    };

    const workspace3: AgentExecutionContext = {
      workspaceId: "log-ws",
      sessionId: "session-3",
      streamId: "stream-3",
      onStreamEvent: (event: StreamEvent) => {
        if (event.type === "text") {
          ws3Events.push(event.content);
        }
      },
    };

    // MOCK: Agent that emits workspace-specific event patterns
    const mockAgent = {
      metadata: {
        id: "multi-event-agent",
        version: "1.0.0",
        description: "",
        displayName: "Multi Event Agent",
        expertise: {
          domains: ["testing"],
          capabilities: ["basic execution"],
          examples: ["run test task"],
        },
      },
      execute: (_prompt: string, context: AgentContext) => {
        // Different event patterns per workspace
        if (context.session.workspaceId === "counter-ws") {
          for (let i = 0; i < 5; i++) {
            context.stream.emit({ type: "progress", percentage: i * 20, message: `Step ${i}` });
          }
        } else if (context.session.workspaceId === "sum-ws") {
          context.stream.emit({ type: "progress", percentage: 10, message: "First" });
          context.stream.emit({ type: "progress", percentage: 20, message: "Second" });
          context.stream.emit({ type: "progress", percentage: 30, message: "Third" });
        } else if (context.session.workspaceId === "log-ws") {
          context.stream.emit({ type: "text", content: "Line 1" });
          context.stream.emit({ type: "text", content: "Line 2" });
          context.stream.emit({ type: "text", content: "Line 3" });
        }
        return Promise.resolve({ result: "done" });
      },
      environmentConfig: undefined,
      mcpConfig: undefined,
      llmConfig: undefined,
    };
    orchestrator.registerWrappedAgent("multi-event-agent", mockAgent);

    // Execute all three workspaces with their specific handlers
    await Promise.all([
      orchestrator.executeAgent("multi-event-agent", "task", workspace1),
      orchestrator.executeAgent("multi-event-agent", "task", workspace2),
      orchestrator.executeAgent("multi-event-agent", "task", workspace3),
    ]);

    // KEY TEST: Each workspace's handler processed only its events
    assertEquals(ws1Count, 5); // Counted 5 progress events
    assertEquals(ws2Sum, 60); // Sum of 10 + 20 + 30
    assertEquals(ws3Events, ["Line 1", "Line 2", "Line 3"]); // Collected 3 text events

    await orchestrator.shutdown();
  });
});
