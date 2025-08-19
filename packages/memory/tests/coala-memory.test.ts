import { expect } from "@std/expect";
import { CoALAMemoryManager, CoALAMemoryType } from "../src/coala-memory.ts";
import { AtlasScope } from "../../../src/core/scope.ts";
import { InMemoryStorageAdapter } from "@atlas/storage";

// Set testing environment to prevent logger file operations
Deno.env.set("DENO_TESTING", "true");

// Helper to create memory manager with immediate commits for tests
function createTestMemoryManager(scope: any, adapter: any, enableCognitiveLoop = false) {
  return new CoALAMemoryManager(
    scope,
    adapter,
    enableCognitiveLoop,
    { commitDebounceDelay: 0 }, // Immediate commits for tests
  );
}

Deno.test("CoALAMemoryManager - basic memory operations", async () => {
  const scope = new AtlasScope();
  const memory = createTestMemoryManager(scope, new InMemoryStorageAdapter());

  // Test storing and retrieving memory
  memory.remember("test-key", "test-value");
  const retrieved = memory.recall("test-key");

  expect(retrieved).toBe("test-value");

  // Cleanup
  await memory.dispose();
});

Deno.test("CoALAMemoryManager - memory with metadata", async () => {
  const scope = new AtlasScope();
  const memory = createTestMemoryManager(scope, new InMemoryStorageAdapter());

  // Test storing memory with metadata
  memory.rememberWithMetadata("test-key", "test-value", {
    memoryType: CoALAMemoryType.SEMANTIC,
    tags: ["test", "semantic"],
    relevanceScore: 0.8,
    confidence: 0.9,
    decayRate: 0.05,
  });

  const retrieved = memory.recall("test-key");
  expect(retrieved).toBe("test-value");

  // Cleanup
  await memory.dispose();
});

Deno.test("CoALAMemoryManager - memory queries", async () => {
  const scope = new AtlasScope();
  const memory = createTestMemoryManager(scope, new InMemoryStorageAdapter());

  // Store multiple memories
  memory.rememberWithMetadata("key1", "value1", {
    memoryType: CoALAMemoryType.EPISODIC,
    tags: ["test", "episodic"],
    relevanceScore: 0.7,
    confidence: 0.8,
    decayRate: 0.1,
  });

  memory.rememberWithMetadata("key2", "value2", {
    memoryType: CoALAMemoryType.SEMANTIC,
    tags: ["test", "semantic"],
    relevanceScore: 0.9,
    confidence: 0.95,
    decayRate: 0.05,
  });

  // Query memories
  const memories = memory.queryMemories({
    tags: ["test"],
    minRelevance: 0.5,
    limit: 10,
  });

  expect(memories).toHaveLength(2);

  // Cleanup
  await memory.dispose();
});

Deno.test("CoALAMemoryManager - memory by type", async () => {
  const scope = new AtlasScope();
  const memory = createTestMemoryManager(scope, new InMemoryStorageAdapter());

  // Store memories of different types
  memory.rememberWithMetadata("episodic1", "episodic value", {
    memoryType: CoALAMemoryType.EPISODIC,
    tags: ["episodic"],
    relevanceScore: 0.8,
    confidence: 0.9,
    decayRate: 0.1,
  });

  memory.rememberWithMetadata("semantic1", "semantic value", {
    memoryType: CoALAMemoryType.SEMANTIC,
    tags: ["semantic"],
    relevanceScore: 0.9,
    confidence: 0.95,
    decayRate: 0.05,
  });

  // Get memories by type
  const episodicMemories = memory.getMemoriesByType(CoALAMemoryType.EPISODIC);
  const semanticMemories = memory.getMemoriesByType(CoALAMemoryType.SEMANTIC);

  expect(episodicMemories).toHaveLength(1);
  expect(semanticMemories).toHaveLength(1);
  expect(episodicMemories[0].content).toBe("episodic value");
  expect(semanticMemories[0].content).toBe("semantic value");

  // Cleanup
  await memory.dispose();
});

Deno.test("CoALAMemoryManager - forgetting memories", async () => {
  const scope = new AtlasScope();
  const memory = createTestMemoryManager(scope, new InMemoryStorageAdapter());

  // Store a memory
  memory.remember("forget-me", "temporary value");

  // Verify it exists
  let retrieved = memory.recall("forget-me");
  expect(retrieved).toBe("temporary value");

  // Forget it
  memory.forget("forget-me");

  // Verify it's gone
  retrieved = memory.recall("forget-me");
  expect(retrieved).toBeUndefined();

  // Cleanup
  await memory.dispose();
});

Deno.test("CoALAMemoryManager - cognitive loop reflection", async () => {
  const scope = new AtlasScope();
  const memory = createTestMemoryManager(scope, new InMemoryStorageAdapter());

  // Store some memories and access them multiple times to trigger reflection criteria
  memory.rememberWithMetadata("reflect1", "reflection value 1", {
    memoryType: CoALAMemoryType.EPISODIC,
    tags: ["reflection"],
    relevanceScore: 0.8,
    confidence: 0.9,
    decayRate: 0.1,
  });

  memory.rememberWithMetadata("reflect2", "reflection value 2", {
    memoryType: CoALAMemoryType.SEMANTIC,
    tags: ["reflection"],
    relevanceScore: 0.9,
    confidence: 0.95,
    decayRate: 0.05,
  });

  // Access memories multiple times to make them candidates for reflection
  for (let i = 0; i < 6; i++) {
    memory.recall("reflect1");
    memory.recall("reflect2");
  }

  // Simulate time passing to make memories old enough for reflection
  // Access the internal memories to manipulate timestamp for testing
  const memories = (memory).memories;
  const memory1 = memories.get("reflect1");
  const memory2 = memories.get("reflect2");

  if (memory1) {
    memory1.timestamp = new Date(Date.now() - 2 * 3600000); // 2 hours ago
  }
  if (memory2) {
    memory2.timestamp = new Date(Date.now() - 2 * 3600000); // 2 hours ago
  }

  // Test reflection
  const reflections = memory.reflect();
  expect(reflections).toHaveLength(2);
  expect(reflections.every((r) => r.tags.includes("reflection"))).toBe(true);

  // Cleanup
  await memory.dispose();
});

Deno.test("CoALAMemoryManager - memory consolidation", async () => {
  const scope = new AtlasScope();
  const memory = createTestMemoryManager(scope, new InMemoryStorageAdapter());

  // Store similar memories
  for (let i = 0; i < 5; i++) {
    memory.rememberWithMetadata(`similar-${i}`, `similar content ${i}`, {
      memoryType: CoALAMemoryType.EPISODIC,
      tags: ["similar", "consolidate"],
      relevanceScore: 0.7,
      confidence: 0.8,
      decayRate: 0.1,
    });
  }

  // Consolidate should not throw
  expect(() => memory.consolidate()).not.toThrow();

  // Cleanup
  await memory.dispose();
});

Deno.test("CoALAMemoryManager - memory pruning", async () => {
  const scope = new AtlasScope();
  const memory = createTestMemoryManager(scope, new InMemoryStorageAdapter());

  // Store memories with different decay rates
  memory.rememberWithMetadata("fast-decay", "fast decaying memory", {
    memoryType: CoALAMemoryType.WORKING,
    tags: ["fast"],
    relevanceScore: 0.5,
    confidence: 0.6,
    decayRate: 0.9, // High decay rate
  });

  memory.rememberWithMetadata("slow-decay", "slow decaying memory", {
    memoryType: CoALAMemoryType.SEMANTIC,
    tags: ["slow"],
    relevanceScore: 0.9,
    confidence: 0.95,
    decayRate: 0.01, // Low decay rate
  });

  // Prune should not throw
  expect(() => memory.prune()).not.toThrow();

  // Cleanup
  await memory.dispose();
});

Deno.test("CoALAMemoryManager - memory adaptation", async () => {
  const scope = new AtlasScope();
  const memory = createTestMemoryManager(scope, new InMemoryStorageAdapter());

  // Store a memory
  memory.rememberWithMetadata("adapt-me", "adaptable memory", {
    memoryType: CoALAMemoryType.PROCEDURAL,
    tags: ["adaptable"],
    relevanceScore: 0.7,
    confidence: 0.8,
    decayRate: 0.1,
  });

  // Adapt with feedback
  const feedback = { success: true, relevance: 0.9 };
  expect(() => memory.adapt(feedback)).not.toThrow();

  // Cleanup
  await memory.dispose();
});

Deno.test("CoALAMemoryManager - memory disposal", async () => {
  const scope = new AtlasScope();
  const memory = createTestMemoryManager(scope, new InMemoryStorageAdapter());

  // Store a memory
  memory.remember("dispose-test", "test value");

  // Dispose should not throw
  await expect(memory.dispose()).resolves.not.toThrow();
});

Deno.test("CoALAMemoryManager - memory serialization", async () => {
  const scope = new AtlasScope();
  const memory = createTestMemoryManager(scope, new InMemoryStorageAdapter());

  // Store complex data
  const complexData = {
    text: "complex memory",
    numbers: [1, 2, 3],
    nested: { key: "value" },
  };

  memory.remember("complex-data", complexData);
  const retrieved = memory.recall("complex-data");

  expect(retrieved).toEqual(complexData);

  // Cleanup
  await memory.dispose();
});
