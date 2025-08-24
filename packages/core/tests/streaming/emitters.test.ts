import { assertEquals, assertExists } from "@std/assert";
import { CollectingStreamEmitter, NoOpStreamEmitter } from "../../src/streaming/stream-emitters.ts";

/**
 * Tests StreamEmitter implementations - the foundation of Atlas streaming.
 *
 * ATLAS ARCHITECTURE CONTEXT:
 * StreamEmitters are the base abstraction for event transmission. When agents run,
 * they emit events through these emitters. The actual implementation varies:
 * - CollectingStreamEmitter: Buffers events when SSE isn't available, returns them in response metadata
 * - NoOpStreamEmitter: Used when no streamId exists, discards all events gracefully
 * - HTTPStreamEmitter: (tested elsewhere) Streams to daemon/SSE endpoint
 * - MCPStreamEmitter: (tested elsewhere) Sends MCP notifications
 *
 * These tests verify pure implementations without mocking - testing actual runtime behavior.
 */
Deno.test("Event Collection Without SSE", async (t) => {
  await t.step("should collect all events when SSE is not available", () => {
    const emitter = new CollectingStreamEmitter();

    // Simulate agent execution lifecycle events
    emitter.emit({ type: "text", content: "Starting..." });
    emitter.emit({ type: "tool-call", toolName: "search", args: { query: "test" } });
    emitter.emit({ type: "tool-result", toolName: "search", result: { found: 10 } });
    emitter.emit({ type: "finish", reason: "complete" });

    const events = emitter.getCollectedEvents();
    assertEquals(events.length, 4);

    // Check first event (text)
    assertExists(events[0]);
    assertEquals(events[0].type, "text");
    if (events[0].type === "text") {
      assertEquals(events[0].content, "Starting...");
    }

    // Check second event (tool-call)
    assertExists(events[1]);
    assertEquals(events[1].type, "tool-call");
    if (events[1].type === "tool-call") {
      assertEquals(events[1].toolName, "search");
    }

    // Check third event (tool-result)
    assertExists(events[2]);
    assertEquals(events[2].type, "tool-result");
    if (events[2].type === "tool-result") {
      assertEquals(events[2].toolName, "search");
    }

    // Check fourth event (finish)
    assertExists(events[3]);
    assertEquals(events[3].type, "finish");
    if (events[3].type === "finish") {
      assertEquals(events[3].reason, "complete");
    }
  });

  await t.step("should handle edge cases in buffered streaming", () => {
    // Tests collector behavior at boundaries
    const emitter = new CollectingStreamEmitter();

    // After end(), emitter stops collecting (prevents memory leaks)
    emitter.end();
    emitter.emit({ type: "text", content: "Late event" });
    assertEquals(emitter.getCollectedEvents().length, 0);

    // Error events are collected like any other event
    const emitter2 = new CollectingStreamEmitter();
    const testError = new Error("Test error");
    emitter2.error(testError);
    const events = emitter2.getCollectedEvents();
    assertEquals(events.length, 1);
    assertExists(events[0]);
    assertEquals(events[0].type, "error");
    if (events[0].type === "error") {
      assertExists(events[0].error);
      assertEquals(events[0].error, testError);
    }

    // Stress test: handles large event volumes without issues
    const emitter3 = new CollectingStreamEmitter();
    for (let i = 0; i < 1000; i++) {
      emitter3.emit({ type: "text", content: `Event ${i}` });
    }
    assertEquals(emitter3.getCollectedEvents().length, 1000);
  });

  await t.step("should properly integrate with agent execution", () => {
    /**
     * Tests how CollectingStreamEmitter integrates with agent execution.
     * In Atlas, when SSE isn't available, events are collected and returned
     * in the agent result metadata for the supervisor to process.
     */
    const emitter = new CollectingStreamEmitter();
    emitter.emit({ type: "thinking", content: "Analyzing request..." });
    emitter.emit({ type: "progress", percentage: 25, message: "Searching database" });
    emitter.emit({ type: "progress", percentage: 50, message: "Processing results" });
    emitter.emit({
      type: "tool-call",
      toolName: "database_query",
      args: { sql: "SELECT * FROM users" },
    });
    emitter.emit({
      type: "tool-result",
      toolName: "database_query",
      result: [{ id: 1, name: "Test User" }],
    });
    emitter.emit({ type: "progress", percentage: 75, message: "Formatting response" });
    emitter.emit({ type: "text", content: "Found 1 user in the database." });
    emitter.emit({ type: "usage", tokens: { input: 100, output: 50 } });
    emitter.emit({ type: "finish", reason: "complete" });

    const collectedEvents = emitter.getCollectedEvents();

    // Events maintain order for supervisor to replay
    assertEquals(collectedEvents.length, 9);
    assertExists(collectedEvents[0]);
    assertEquals(collectedEvents[0].type, "thinking");
    assertExists(collectedEvents[1]);
    assertEquals(collectedEvents[1].type, "progress");
    if (collectedEvents[1].type === "progress") {
      assertEquals(collectedEvents[1].percentage, 25);
    }
    assertExists(collectedEvents[8]);
    assertEquals(collectedEvents[8].type, "finish");

    // This is how the agent-execution-machine packages events
    const resultMetadata = { streamEvents: collectedEvents };

    assertExists(resultMetadata.streamEvents);
    assertEquals(resultMetadata.streamEvents.length, 9);
  });

  await t.step("should handle custom events", () => {
    // Atlas agents can emit custom events for specialized workflows
    const emitter = new CollectingStreamEmitter();
    emitter.emit({
      type: "custom",
      eventType: "model.switch",
      data: { from: "gpt-4", to: "claude-3" },
    });
    emitter.emit({
      type: "custom",
      eventType: "rate.limit",
      data: { remaining: 10, reset: Date.now() + 60000 },
    });

    const events = emitter.getCollectedEvents();
    assertEquals(events.length, 2);
    assertExists(events[0]);
    assertEquals(events[0].type, "custom");
    if (events[0].type === "custom") {
      assertEquals(events[0].eventType, "model.switch");
      assertExists(events[0].data);
    }
    assertExists(events[1]);
    if (events[1].type === "custom") {
      assertEquals(events[1].eventType, "rate.limit");
    }
  });
});

Deno.test("NoOpStreamEmitter behavior", async (t) => {
  await t.step("should gracefully handle all operations", () => {
    /**
     * NoOpStreamEmitter is used when no streamId exists (no streaming requested).
     * In Atlas, this ensures agents can always call stream.emit() without
     * checking if streaming is enabled - simplifies agent code.
     */
    const emitter = new NoOpStreamEmitter();

    // All operations are no-ops - events are discarded
    emitter.emit({ type: "text", content: "test" });
    emitter.emit({ type: "tool-call", toolName: "test", args: {} });
    emitter.end();
    emitter.error(new Error("test error"));

    // Validates graceful degradation when streaming not needed
    assertEquals(true, true);
  });
});
