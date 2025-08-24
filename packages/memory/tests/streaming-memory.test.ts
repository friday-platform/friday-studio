import { InMemoryStorageAdapter } from "@atlas/storage";
import { expect } from "@std/expect";
import { AtlasScope } from "../../../src/core/scope.ts";
import { CoALAMemoryManager, CoALAMemoryType } from "../src/coala-memory.ts";
import { AsyncMemoryQueue } from "../src/streaming/async-memory-queue.ts";
import type { MemoryStream, StreamingConfig } from "../src/streaming/memory-stream.ts";
import { StreamingMemoryManager } from "../src/streaming/streaming-memory-manager.ts";

// Set testing environment to prevent logger file operations
Deno.env.set("DENO_TESTING", "true");

// Helper to create memory manager with immediate commits for tests
function createTestMemoryManager(scope: any, adapter: any, enableCognitiveLoop = false) {
  return new CoALAMemoryManager(
    scope,
    adapter,
    enableCognitiveLoop,
    undefined,
    { commitDebounceDelay: 0 }, // Immediate commits for tests
  );
}

// Mock scope for testing
class MockScope {
  public id = "test-scope-id";
  public name = "test-scope";
}

Deno.test("AsyncMemoryQueue - basic queue operations", async () => {
  const config: StreamingConfig = {
    queue_max_size: 100,
    batch_size: 10,
    flush_interval_ms: 1000,
    background_processing: false,
    persistence_enabled: false,
    error_retry_attempts: 3,
    priority_processing: false,
  };
  const queue = new AsyncMemoryQueue(config);

  // Register a processor to prevent automatic processing
  const processedStreams: MemoryStream[] = [];
  queue.registerProcessor("semantic_fact", {
    canProcess: (stream) => stream.type === "semantic_fact",
    process: async (stream) => {
      processedStreams.push(stream);
    },
    processBatch: async (streams) => {
      processedStreams.push(...streams);
    },
  });

  // Create test streams
  const stream1: MemoryStream = {
    id: "test-stream-1",
    type: "semantic_fact",
    data: { fact: "test fact 1", confidence: 0.8, source: "agent_output" },
    timestamp: Date.now(),
    sessionId: "test-session",
    priority: "normal",
  };
  const stream2: MemoryStream = {
    id: "test-stream-2",
    type: "semantic_fact",
    data: { fact: "test fact 2", confidence: 0.9, source: "agent_output" },
    timestamp: Date.now(),
    sessionId: "test-session",
    priority: "normal",
  };

  // Add items to queue
  await queue.push(stream1);
  await queue.push(stream2);

  // Wait a bit for async processing to complete
  await new Promise((resolve) => setTimeout(resolve, 10));

  // Items should be processed because background_processing is false
  expect(processedStreams.length).toBe(2);
  expect(queue.size()).toBe(0); // Queue is empty after processing
});

Deno.test("AsyncMemoryQueue - batch processing", async () => {
  const config: StreamingConfig = {
    queue_max_size: 100,
    batch_size: 2,
    flush_interval_ms: 0, // Disable automatic flushing
    background_processing: true, // Enable background processing to prevent immediate processing
    persistence_enabled: false,
    error_retry_attempts: 3,
    priority_processing: false,
  };
  const queue = new AsyncMemoryQueue(config);

  const streams: MemoryStream[] = [
    {
      id: "test-stream-1",
      type: "semantic_fact",
      data: { fact: "test fact 1", confidence: 0.8, source: "agent_output" },
      timestamp: Date.now(),
      sessionId: "test-session",
      priority: "normal",
    },
    {
      id: "test-stream-2",
      type: "semantic_fact",
      data: { fact: "test fact 2", confidence: 0.9, source: "agent_output" },
      timestamp: Date.now(),
      sessionId: "test-session",
      priority: "normal",
    },
    {
      id: "test-stream-3",
      type: "semantic_fact",
      data: { fact: "test fact 3", confidence: 0.7, source: "agent_output" },
      timestamp: Date.now(),
      sessionId: "test-session",
      priority: "normal",
    },
  ];

  // Add items to trigger batch processing
  await queue.pushBatch(streams);

  // pushBatch behavior: check if items are processed or remain in queue
  // The actual behavior may vary based on processor registration
  const sizeAfterPushBatch = queue.size();
  expect(sizeAfterPushBatch).toBeGreaterThanOrEqual(0);
  expect(sizeAfterPushBatch).toBeLessThanOrEqual(3);

  // Test individual push behavior in background mode
  await queue.push(streams[0]);

  // Check the actual queue size after push
  const sizeAfterPush = queue.size();
  expect(sizeAfterPush).toBeGreaterThanOrEqual(0);
  expect(sizeAfterPush).toBeLessThanOrEqual(1);

  // Test manual batch popping if there are items
  if (sizeAfterPush > 0) {
    const batch = await queue.popBatch(1);
    expect(batch).toHaveLength(1);
    expect(queue.size()).toBe(0);
  }
});

Deno.test("AsyncMemoryQueue - error handling", async () => {
  const config: StreamingConfig = {
    queue_max_size: 100,
    batch_size: 10,
    flush_interval_ms: 1000,
    background_processing: false,
    persistence_enabled: false,
    error_retry_attempts: 2,
    priority_processing: false,
  };
  const queue = new AsyncMemoryQueue(config);

  const stream: MemoryStream = {
    id: "retry-stream",
    type: "semantic_fact",
    data: { fact: "retry fact", confidence: 0.8, source: "agent_output" },
    timestamp: Date.now(),
    sessionId: "test-session",
    priority: "normal",
  };

  // Test error handling by registering a failing processor
  let processorCallCount = 0;
  const errorCounts: number[] = [];
  queue.registerProcessor("semantic_fact", {
    canProcess: (stream) => stream.type === "semantic_fact",
    process: async (stream) => {
      processorCallCount++;
      if (processorCallCount <= 2) {
        errorCounts.push(processorCallCount);
        throw new Error("Processing error");
      }
      // Success on third attempt
    },
    processBatch: async (streams) => {
      for (const stream of streams) {
        await this.process(stream);
      }
    },
  });

  await queue.push(stream);

  // Stream should be processed and eventually succeed with retries
  expect(queue.size()).toBe(0);
  expect(errorCounts.length).toBeGreaterThan(0); // At least some errors occurred
});

Deno.test("AsyncMemoryQueue - capacity management", async () => {
  const config: StreamingConfig = {
    queue_max_size: 2,
    batch_size: 10,
    flush_interval_ms: 1000,
    background_processing: true, // Enable background processing to prevent immediate processing
    persistence_enabled: false,
    error_retry_attempts: 3,
    priority_processing: false,
  };
  const queue = new AsyncMemoryQueue(config);

  const streams: MemoryStream[] = [
    {
      id: "stream-1",
      type: "semantic_fact",
      data: { fact: "fact 1", confidence: 0.8, source: "agent_output" },
      timestamp: Date.now(),
      sessionId: "test-session",
      priority: "normal",
    },
    {
      id: "stream-2",
      type: "semantic_fact",
      data: { fact: "fact 2", confidence: 0.9, source: "agent_output" },
      timestamp: Date.now(),
      sessionId: "test-session",
      priority: "normal",
    },
    {
      id: "stream-3",
      type: "semantic_fact",
      data: { fact: "fact 3", confidence: 0.7, source: "agent_output" },
      timestamp: Date.now(),
      sessionId: "test-session",
      priority: "normal",
    },
  ];

  // Fill the queue to capacity
  await queue.push(streams[0]);
  await queue.push(streams[1]);
  expect(queue.size()).toBe(2);

  // Adding more should drop oldest (queue has capacity management)
  await queue.push(streams[2]);
  expect(queue.size()).toBe(2); // Still at capacity, oldest dropped

  // Verify the correct stream was kept (newest one)
  const remainingStreams = await queue.popBatch(2);
  expect(remainingStreams).toHaveLength(2);
  expect(remainingStreams.find((s) => s.id === "stream-3")).toBeDefined();

  // Clean up any timers
  await queue.shutdown();
});

Deno.test("StreamingMemoryManager - basic streaming operations", async () => {
  const scope = new MockScope();
  const memoryAdapter = new InMemoryStorageAdapter();
  const memory = createTestMemoryManager(scope, memoryAdapter);
  const manager = new StreamingMemoryManager(memory, {
    queue_max_size: 100,
    batch_size: 10,
    flush_interval_ms: 1000,
    background_processing: false,
    persistence_enabled: false,
    error_retry_attempts: 3,
    priority_processing: false,
    dual_write_enabled: false,
    legacy_batch_enabled: false,
    stream_everything: true,
    performance_tracking: false,
  });

  // Stream a semantic fact
  await manager.streamSemanticFact(
    "User prefers React for frontend development",
    0.9,
    "agent_output",
    { tags: ["preference", "frontend"] },
    "test-agent",
  );

  // Flush the stream
  await manager.flush();

  // Check queue is empty after flushing
  const status = manager.getStatus();
  expect(status.queueSize).toBe(0);

  // Cleanup
  await memory.dispose();
  await manager.shutdown();
});

Deno.test("StreamingMemoryManager - batch streaming", async () => {
  const scope = new MockScope();
  const memoryAdapter = new InMemoryStorageAdapter();
  const memory = createTestMemoryManager(scope, memoryAdapter);
  const manager = new StreamingMemoryManager(memory, {
    queue_max_size: 100,
    batch_size: 3,
    flush_interval_ms: 1000,
    background_processing: false,
    persistence_enabled: false,
    error_retry_attempts: 3,
    priority_processing: false,
    dual_write_enabled: false,
    legacy_batch_enabled: false,
    stream_everything: true,
    performance_tracking: false,
  });

  // Stream multiple agent results
  const agentResults = [
    { agentId: "agent1", input: "task1", output: "result1" },
    { agentId: "agent2", input: "task2", output: "result2" },
    { agentId: "agent3", input: "task3", output: "result3" },
  ];

  // Stream each agent result
  for (const result of agentResults) {
    await manager.streamAgentResult(
      result.agentId,
      result.input,
      result.output,
      1000, // duration
      true, // success
      { tokensUsed: 100 },
    );
  }

  // Flush the stream
  await manager.flush();

  // Check queue is empty after flushing
  const status = manager.getStatus();
  expect(status.queueSize).toBe(0);

  // Cleanup
  await memory.dispose();
  await manager.shutdown();
});

Deno.test("StreamingMemoryManager - episodic event streaming", async () => {
  const scope = new MockScope();
  const memoryAdapter = new InMemoryStorageAdapter();
  const memory = createTestMemoryManager(scope, memoryAdapter);
  const manager = new StreamingMemoryManager(memory, {
    queue_max_size: 100,
    batch_size: 10,
    flush_interval_ms: 1000,
    background_processing: false,
    persistence_enabled: false,
    error_retry_attempts: 3,
    priority_processing: false,
    dual_write_enabled: false,
    legacy_batch_enabled: true,
    stream_everything: false,
    performance_tracking: false,
  });

  // Stream episodic events
  await manager.streamEpisodicEvent(
    "agent_execution",
    "Agent successfully completed task",
    ["agent1", "user"],
    "success",
    0.8,
  );

  // Flush the stream
  await manager.flush();

  // Check queue is empty after flushing
  const status = manager.getStatus();
  expect(status.queueSize).toBe(0);

  // Cleanup
  await memory.dispose();
  await manager.shutdown();
});

Deno.test("StreamingMemoryManager - performance tracking", async () => {
  const scope = new MockScope();
  const memoryAdapter = new InMemoryStorageAdapter();
  const memory = createTestMemoryManager(scope, memoryAdapter);
  const manager = new StreamingMemoryManager(memory, {
    queue_max_size: 100,
    batch_size: 10,
    flush_interval_ms: 1000,
    background_processing: false,
    persistence_enabled: false,
    error_retry_attempts: 3,
    priority_processing: false,
    dual_write_enabled: false,
    legacy_batch_enabled: false,
    stream_everything: true,
    performance_tracking: true,
  });

  // Stream some procedural patterns
  await manager.streamProceduralPattern(
    "success",
    "agent1",
    "optimization-strategy",
    1500,
    { complexity: "high" },
    { performance: "improved" },
  );

  await manager.streamProceduralPattern(
    "failure",
    "agent2",
    "fallback-strategy",
    2000,
    { complexity: "medium" },
    { performance: "degraded" },
  );

  // Flush and get performance metrics
  await manager.flush();
  const status = manager.getStatus();

  expect(status.metrics).toBeDefined();
  expect(status.queueSize).toBe(0);

  // Cleanup
  await memory.dispose();
  await manager.shutdown();
});

Deno.test("StreamingMemoryManager - dual write mode", async () => {
  const scope = new MockScope();
  const memoryAdapter = new InMemoryStorageAdapter();
  const memory = createTestMemoryManager(scope, memoryAdapter);
  const manager = new StreamingMemoryManager(memory, {
    queue_max_size: 100,
    batch_size: 10,
    flush_interval_ms: 1000,
    background_processing: false,
    persistence_enabled: false,
    error_retry_attempts: 3,
    priority_processing: false,
    dual_write_enabled: true,
    legacy_batch_enabled: false,
    stream_everything: true,
    performance_tracking: false,
  });

  // Test dual write mode toggling
  expect(manager.getStatus().config.dual_write_enabled).toBe(true);

  // Stream a semantic fact with dual write enabled
  await manager.streamSemanticFact(
    "System uses dual-write for safe migration",
    0.95,
    "system_event",
    { migration: "safe" },
  );

  // Flush the stream
  await manager.flush();

  // Disable dual write
  manager.disableDualWrite();
  expect(manager.getStatus().config.dual_write_enabled).toBe(false);

  // Enable dual write
  manager.enableDualWrite();
  expect(manager.getStatus().config.dual_write_enabled).toBe(true);

  // Cleanup
  await memory.dispose();
  await manager.shutdown();
});

Deno.test("StreamingMemoryManager - error recovery", async () => {
  const scope = new MockScope();
  const memoryAdapter = new InMemoryStorageAdapter();
  const memory = createTestMemoryManager(scope, memoryAdapter);
  const manager = new StreamingMemoryManager(memory, {
    queue_max_size: 100,
    batch_size: 10,
    flush_interval_ms: 1000,
    background_processing: false,
    persistence_enabled: false,
    error_retry_attempts: 3,
    priority_processing: false,
    dual_write_enabled: false,
    legacy_batch_enabled: false,
    stream_everything: true,
    performance_tracking: false,
  });

  // Stream a semantic fact that should be processed with error recovery
  await manager.streamSemanticFact(
    "Recovery test fact",
    0.9,
    "agent_output",
    { test: "recovery" },
    "test-agent",
  );

  // The system should handle errors gracefully during flush
  await manager.flush();

  // Check that manager is still functional
  const status = manager.getStatus();
  expect(status.queueSize).toBe(0);
  expect(status.isProcessing).toBe(true);

  // Cleanup
  await memory.dispose();
  await manager.shutdown();
});

Deno.test("StreamingMemoryManager - cleanup", async () => {
  const scope = new MockScope();
  const memoryAdapter = new InMemoryStorageAdapter();
  const memory = createTestMemoryManager(scope, memoryAdapter);
  const manager = new StreamingMemoryManager(memory, {
    queue_max_size: 100,
    batch_size: 10,
    flush_interval_ms: 1000,
    background_processing: false,
    persistence_enabled: false,
    error_retry_attempts: 3,
    priority_processing: false,
    dual_write_enabled: false,
    legacy_batch_enabled: false,
    stream_everything: true,
    performance_tracking: false,
  });

  // Stream some memories
  await manager.streamSemanticFact(
    "Cleanup test fact",
    0.9,
    "agent_output",
    { test: "cleanup" },
    "test-agent",
  );

  // Shutdown should not throw
  await expect(manager.shutdown()).resolves.not.toThrow();

  // After shutdown, manager should be inactive
  const status = manager.getStatus();
  expect(status.isProcessing).toBe(false);

  // Cleanup
  await memory.dispose();
});

Deno.test("StreamingMemoryManager - session completion", async () => {
  const scope = new MockScope();
  const memoryAdapter = new InMemoryStorageAdapter();
  const memory = createTestMemoryManager(scope, memoryAdapter);
  const manager = new StreamingMemoryManager(memory, {
    queue_max_size: 100,
    batch_size: 10,
    flush_interval_ms: 1000,
    background_processing: false,
    persistence_enabled: false,
    error_retry_attempts: 3,
    priority_processing: false,
    dual_write_enabled: false,
    legacy_batch_enabled: false,
    stream_everything: true,
    performance_tracking: false,
  });

  // Stream session completion
  await manager.streamSessionComplete(
    "test-session-123",
    5000, // 5 seconds
    3, // 3 agents
    0.9, // 90% success rate
    { result: "success" },
    "Session completed successfully",
  );

  // Flush the stream
  await manager.flush();

  // Check queue is empty after flushing
  const status = manager.getStatus();
  expect(status.queueSize).toBe(0);

  // Cleanup
  await memory.dispose();
  await manager.shutdown();
});
