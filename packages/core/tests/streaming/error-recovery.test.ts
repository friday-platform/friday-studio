import { assertEquals, assertExists } from "@std/assert";
import { restore, stub } from "@std/testing/mock";
import { AgentOrchestrator } from "../../src/orchestrator/agent-orchestrator.ts";
import { HTTPStreamEmitter, MCPStreamEmitter } from "../../src/streaming/stream-emitters.ts";
import { createLogger } from "@atlas/logger";
import type { AgentContext, StreamEvent } from "@atlas/agent-sdk";

/**
 * Tests streaming resilience - ensures Atlas continues working when streaming fails.
 *
 * ATLAS ARCHITECTURE CONTEXT:
 * Streaming is a "nice to have" feature - agent execution must never fail due to
 * streaming errors. These tests verify the fire-and-forget nature of streaming:
 * - Network failures don't block agent execution
 * - MCP notification errors are handled gracefully
 * - HTTP stream emitter recovers from intermittent failures
 * - Concurrent stream errors don't cause cascading failures
 *
 * MOCKING STRATEGY:
 * - Stubs globalThis.fetch to simulate network failures
 * - Creates mock MCP servers that reject notifications
 * - Uses real AgentOrchestrator with mock agents to test error boundaries
 */
Deno.test("Streaming Error Recovery", async (t) => {
  await t.step("should continue execution when streaming fails", async () => {
    // MOCK: Stub fetch to fail, simulating network outage
    stub(globalThis, "fetch", () => {
      return Promise.reject(new Error("Network error"));
    });

    try {
      const config = {
        agentsServerUrl: "http://localhost:8081/mcp",
        executionTimeout: 10000,
      };
      const logger = createLogger({ level: "error" });
      const orchestrator = new AgentOrchestrator(config, logger);
      orchestrator.initialize();

      // MOCK: Simple agent that doesn't depend on streaming
      orchestrator.registerWrappedAgent("agent", {
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
        execute: () => Promise.resolve({ result: "success" }),
        environmentConfig: undefined,
        mcpConfig: undefined,
        llmConfig: undefined,
      });

      const result = await orchestrator.executeAgent("agent", "task", {
        sessionId: "session-1",
        workspaceId: "workspace-1",
        streamId: "stream-1",
      });

      // KEY TEST: Agent execution succeeds despite streaming failure
      assertExists(result);
      assertExists(result.output);
      assertEquals(result.output.result, "success");

      await orchestrator.shutdown();
    } finally {
      restore();
    }
  });

  await t.step("should handle MCP notification errors gracefully", async () => {
    // MOCK: MCP server that rejects all notifications
    const mockServer = {
      notification: () => Promise.reject(new Error("MCP error")),
    };

    const logger = createLogger({ level: "error" });
    const emitter = new MCPStreamEmitter(
      mockServer as Parameters<typeof MCPStreamEmitter>[0],
      "agent",
      "session-1",
      logger,
    );

    // KEY TEST: Emit operations don't throw even when MCP fails
    try {
      emitter.emit({ type: "text", content: "test" });
      // Wait for async flush to complete
      await new Promise((resolve) => setTimeout(resolve, 100));
      assertEquals(true, true);
    } catch (_error) {
      assertEquals(true, false, "Emit should not throw");
    } finally {
      // Clean up to prevent interval leak
      try {
        await emitter.end();
      } catch {
        // Expected: mock server rejects end notification too
      }
    }
  });

  await t.step("should handle HTTP stream emitter errors", async () => {
    const logger = createLogger({ level: "error" });
    let fetchCallCount = 0;

    // MOCK: Intermittent network failures (simulates flaky connection)
    stub(globalThis, "fetch", () => {
      fetchCallCount++;
      if (fetchCallCount === 1) {
        return Promise.reject(new Error("Network error"));
      }
      return Promise.resolve(new Response("ok"));
    });

    try {
      const emitter = new HTTPStreamEmitter(
        "stream-123",
        "session-1",
        "http://localhost:8080",
        logger,
      );

      // First emit fails internally but doesn't throw to caller
      emitter.emit({ type: "text", content: "test 1" });
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Second emit succeeds after network recovers
      emitter.emit({ type: "text", content: "test 2" });
      await new Promise((resolve) => setTimeout(resolve, 100));

      await emitter.end();

      // Verifies retry logic attempted flush
      assertEquals(fetchCallCount >= 1, true);
    } finally {
      restore();
    }
  });

  await t.step("should recover from agent execution errors while streaming", async () => {
    /**
     * Tests that streaming captures partial events even when agent crashes.
     * In Atlas, supervisors need visibility into agent failures for debugging.
     */
    const config = {
      agentsServerUrl: "http://localhost:8081/mcp",
      executionTimeout: 10000,
    };
    const logger = createLogger({ level: "error" });
    const orchestrator = new AgentOrchestrator(config, logger);
    orchestrator.initialize();

    const streamEvents: StreamEvent[] = [];
    const onStreamEvent = (event: StreamEvent) => streamEvents.push(event);

    // MOCK: Agent that emits events then crashes
    orchestrator.registerWrappedAgent("failing-agent", {
      metadata: {
        id: "failing-agent",
        version: "1.0.0",
        description: "",
        displayName: "Failing Agent",
        expertise: {
          domains: ["testing"],
          capabilities: ["basic execution"],
          examples: ["run test task"],
        },
      },
      execute: (_prompt: string, context: AgentContext) => {
        context.stream.emit({ type: "text", content: "Starting work..." });
        context.stream.emit({ type: "progress", percentage: 50, message: "Halfway" });
        throw new Error("Agent execution failed");
      },
      environmentConfig: undefined,
      mcpConfig: undefined,
      llmConfig: undefined,
    });

    const result = await orchestrator.executeAgent("failing-agent", "task", {
      sessionId: "session-1",
      workspaceId: "workspace-1",
      streamId: "stream-1",
      onStreamEvent,
    });

    // KEY TEST: Error captured in result
    assertExists(result.error);
    assertEquals(result.error, "Agent execution failed");

    // KEY TEST: Events emitted before crash were still delivered
    assertEquals(streamEvents.length, 2);
    assertEquals(streamEvents[0].type, "text");
    assertEquals(streamEvents[1].type, "progress");

    await orchestrator.shutdown();
  });

  await t.step("should handle stream emitter end() errors", async () => {
    const logger = createLogger({ level: "error" });

    // MOCK: Fetch fails only for end marker (specific failure mode)
    stub(globalThis, "fetch", (url: string) => {
      if (url.includes("/stream/end")) {
        return Promise.reject(new Error("End marker failed"));
      }
      return Promise.resolve(new Response("ok"));
    });

    try {
      const emitter = new HTTPStreamEmitter(
        "stream-123",
        "session-1",
        "http://localhost:8080",
        logger,
      );

      emitter.emit({ type: "text", content: "test" });

      // KEY TEST: end() doesn't throw even when end marker fails
      await emitter.end();

      assertEquals(true, true);
    } finally {
      restore();
    }
  });

  await t.step("should handle concurrent stream errors", async () => {
    /**
     * Stress test: Multiple agents streaming concurrently with random failures.
     * Tests that streaming errors don't cause cascading failures in Atlas.
     */
    const config = {
      agentsServerUrl: "http://localhost:8081/mcp",
      executionTimeout: 10000,
    };
    const logger = createLogger({ level: "error" });
    const orchestrator = new AgentOrchestrator(config, logger);
    orchestrator.initialize();

    // MOCK: Random 50% failure rate for network calls
    stub(globalThis, "fetch", () => {
      if (Math.random() > 0.5) {
        return Promise.reject(new Error("Random network error"));
      }
      return Promise.resolve(new Response("ok"));
    });

    try {
      // MOCK: Agent that emits many events
      orchestrator.registerWrappedAgent("agent", {
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
          // Emit 10 events per execution
          for (let i = 0; i < 10; i++) {
            context.stream.emit({ type: "progress", percentage: i * 10, message: `Step ${i}` });
          }
          return { result: "completed" };
        },
        environmentConfig: undefined,
        mcpConfig: undefined,
        llmConfig: undefined,
      });

      // Execute 10 agents concurrently (100 total events with 50% failure rate)
      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(
          orchestrator.executeAgent("agent", "task", {
            sessionId: `session-${i}`,
            workspaceId: "workspace-1",
            streamId: `stream-${i}`,
          }),
        );
      }

      const results = await Promise.all(promises);

      // KEY TEST: All agents complete successfully despite ~50 streaming failures
      for (const result of results) {
        assertExists(result.output);
        assertEquals(result.output.result, "completed");
      }

      await orchestrator.shutdown();
    } finally {
      restore();
    }
  });
});
