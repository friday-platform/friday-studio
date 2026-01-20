import process from "node:process";
import { InMemoryStorageAdapter } from "@atlas/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AtlasScope } from "../../../src/core/scope.ts";
import { CoALAMemoryManager, type IMemoryScope } from "../src/coala-memory.ts";
import {
  embeddingProviderForceDispose,
  embeddingProviderGetInstance,
} from "../src/global-embedding-provider.ts";

// Set testing environment to prevent logger file operations
process.env.DENO_TESTING = "true";

// Helper to create memory manager with immediate commits for tests
function createTestMemoryManager(
  scope: IMemoryScope,
  adapter: InMemoryStorageAdapter,
  enableCognitiveLoop = false,
) {
  return new CoALAMemoryManager(
    scope,
    adapter,
    enableCognitiveLoop,
    { commitDebounceDelay: 0 }, // Immediate commits for tests
  );
}

describe("CoALAMemoryManager", () => {
  // Initialize global embedding provider before tests to avoid message port leak detection
  beforeAll(async () => {
    await embeddingProviderGetInstance();
  });

  // Cleanup global resources after all tests
  afterAll(async () => {
    await embeddingProviderForceDispose();
  });

  it("basic memory operations", async () => {
    const scope = new AtlasScope();
    const memory = createTestMemoryManager(scope, new InMemoryStorageAdapter());

    // Test storing and retrieving memory
    memory.rememberWithMetadata("test-key", "test-value", {
      memoryType: "working",
      tags: ["test", "working"],
      relevanceScore: 0.8,
      confidence: 0.9,
      decayRate: 0.1,
    });
    const retrieved = memory.recall("test-key");

    expect(retrieved).toBe("test-value");

    // Cleanup - wait for any pending operations
    await memory.ensureLoaded();
    await scope.memory.ensureLoaded();
    await memory.dispose();
    await scope.memory.dispose();
  });

  it("memory with metadata", async () => {
    const scope = new AtlasScope();
    const memory = createTestMemoryManager(scope, new InMemoryStorageAdapter());

    // Test storing memory with metadata
    memory.rememberWithMetadata("test-key", "test-value", {
      memoryType: "semantic",
      tags: ["test", "semantic"],
      relevanceScore: 0.8,
      confidence: 0.9,
      decayRate: 0.05,
    });

    const retrieved = memory.recall("test-key");
    expect(retrieved).toBe("test-value");

    // Cleanup - wait for any pending operations
    await memory.ensureLoaded();
    await scope.memory.ensureLoaded();
    await memory.dispose();
    await scope.memory.dispose();
  });

  it("memory queries", async () => {
    const scope = new AtlasScope();
    const memory = createTestMemoryManager(scope, new InMemoryStorageAdapter());

    // Store multiple memories
    memory.rememberWithMetadata("key1", "value1", {
      memoryType: "episodic",
      tags: ["test", "episodic"],
      relevanceScore: 0.7,
      confidence: 0.8,
      decayRate: 0.1,
    });

    memory.rememberWithMetadata("key2", "value2", {
      memoryType: "semantic",
      tags: ["test", "semantic"],
      relevanceScore: 0.9,
      confidence: 0.95,
      decayRate: 0.05,
    });

    // Query memories
    const memories = memory.queryMemories({ tags: ["test"], minRelevance: 0.5, limit: 10 });

    expect(memories).toHaveLength(2);

    // Cleanup - wait for any pending operations
    await memory.ensureLoaded();
    await scope.memory.ensureLoaded();
    await memory.dispose();
    await scope.memory.dispose();
  });

  it("memory by type", async () => {
    const scope = new AtlasScope();
    const memory = createTestMemoryManager(scope, new InMemoryStorageAdapter());

    // Store memories of different types
    memory.rememberWithMetadata("episodic1", "episodic value", {
      memoryType: "episodic",
      tags: ["episodic"],
      relevanceScore: 0.8,
      confidence: 0.9,
      decayRate: 0.1,
    });

    memory.rememberWithMetadata("semantic1", "semantic value", {
      memoryType: "semantic",
      tags: ["semantic"],
      relevanceScore: 0.9,
      confidence: 0.95,
      decayRate: 0.05,
    });

    // Get memories by type
    const episodicMemories = memory.getMemoriesByType("episodic");
    const semanticMemories = memory.getMemoriesByType("semantic");

    expect(episodicMemories).toHaveLength(1);
    expect(semanticMemories).toHaveLength(1);
    expect(episodicMemories[0]?.content).toBe("episodic value");
    expect(semanticMemories[0]?.content).toBe("semantic value");

    // Cleanup - wait for any pending operations
    await memory.ensureLoaded();
    await scope.memory.ensureLoaded();
    await memory.dispose();
    await scope.memory.dispose();
  });

  it("forgetting memories", async () => {
    const scope = new AtlasScope();
    const memory = createTestMemoryManager(scope, new InMemoryStorageAdapter());

    // Store a memory
    memory.rememberWithMetadata("forget-me", "temporary value", {
      memoryType: "working",
      tags: ["forget-me"],
      relevanceScore: 0.8,
      confidence: 0.9,
      decayRate: 0.1,
    });

    // Verify it exists
    let retrieved = memory.recall("forget-me");
    expect(retrieved).toBe("temporary value");

    // Forget it
    memory.forget("forget-me");

    // Verify it's gone
    retrieved = memory.recall("forget-me");
    expect(retrieved).toBeUndefined();

    // Cleanup - wait for any pending operations
    await memory.ensureLoaded();
    await scope.memory.ensureLoaded();
    await memory.dispose();
    await scope.memory.dispose();
  });

  it("memory consolidation", async () => {
    const scope = new AtlasScope();
    const memory = createTestMemoryManager(scope, new InMemoryStorageAdapter());

    // Store similar memories
    for (let i = 0; i < 5; i++) {
      memory.rememberWithMetadata(`similar-${i}`, `similar content ${i}`, {
        memoryType: "episodic",
        tags: ["similar", "consolidate"],
        relevanceScore: 0.7,
        confidence: 0.8,
        decayRate: 0.1,
      });
    }

    // Consolidate should not throw
    expect(() => memory.consolidate()).not.toThrow();

    // Cleanup - wait for any pending operations
    await memory.ensureLoaded();
    await scope.memory.ensureLoaded();
    await memory.dispose();
    await scope.memory.dispose();
  });

  it("memory pruning", async () => {
    const scope = new AtlasScope();
    const memory = createTestMemoryManager(scope, new InMemoryStorageAdapter());

    // Store memories with different decay rates
    memory.rememberWithMetadata("fast-decay", "fast decaying memory", {
      memoryType: "working",
      tags: ["fast"],
      relevanceScore: 0.5,
      confidence: 0.6,
      decayRate: 0.9, // High decay rate
    });

    memory.rememberWithMetadata("slow-decay", "slow decaying memory", {
      memoryType: "semantic",
      tags: ["slow"],
      relevanceScore: 0.9,
      confidence: 0.95,
      decayRate: 0.01, // Low decay rate
    });

    // Prune should not throw
    expect(() => memory.prune()).not.toThrow();

    // Cleanup - wait for any pending operations
    await memory.ensureLoaded();
    await scope.memory.ensureLoaded();
    await memory.dispose();
    await scope.memory.dispose();
  });

  it("memory adaptation", async () => {
    const scope = new AtlasScope();
    const memory = createTestMemoryManager(scope, new InMemoryStorageAdapter());

    // Store a memory
    memory.rememberWithMetadata("adapt-me", "adaptable memory", {
      memoryType: "procedural",
      tags: ["adaptable"],
      relevanceScore: 0.7,
      confidence: 0.8,
      decayRate: 0.1,
    });

    // Adapt with feedback
    const feedback = { memoryId: "adapt-me", relevanceAdjustment: 0.9 };
    expect(() => memory.adapt(feedback)).not.toThrow();

    // Cleanup - wait for any pending operations
    await memory.ensureLoaded();
    await scope.memory.ensureLoaded();
    await memory.dispose();
    await scope.memory.dispose();
  });

  it("memory disposal", async () => {
    const scope = new AtlasScope();
    const memory = createTestMemoryManager(scope, new InMemoryStorageAdapter());

    // Store a memory
    memory.rememberWithMetadata("dispose-test", "test value", {
      memoryType: "working",
      tags: ["dispose-test"],
      relevanceScore: 0.8,
      confidence: 0.9,
      decayRate: 0.1,
    });

    // Cleanup - wait for any pending operations
    await memory.ensureLoaded();
    await scope.memory.ensureLoaded();
    // Dispose should not throw
    await expect(memory.dispose()).resolves.not.toThrow();
    await scope.memory.dispose();
  });

  it("memory serialization", async () => {
    const scope = new AtlasScope();
    const memory = createTestMemoryManager(scope, new InMemoryStorageAdapter());

    // Store complex data
    const complexData = {
      text: "complex memory",
      numbers: JSON.stringify([1, 2, 3]),
      nested: JSON.stringify({ key: "value" }),
    };

    memory.rememberWithMetadata("complex-data", complexData, {
      memoryType: "working",
      tags: ["complex-data"],
      relevanceScore: 0.8,
      confidence: 0.9,
      decayRate: 0.1,
    });
    const retrieved = memory.recall("complex-data");

    expect(retrieved).toEqual(complexData);

    // Cleanup - wait for any pending operations
    await memory.ensureLoaded();
    await scope.memory.ensureLoaded();
    await memory.dispose();
    await scope.memory.dispose();
  });
});
