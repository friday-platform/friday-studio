import { expect } from "@std/expect";
import { CoALAMemoryManager, CoALAMemoryType, type IMemoryScope } from "../src/coala-memory.ts";

// Set testing environment to prevent logger file operations
Deno.env.set("DENO_TESTING", "true");

// Mock all the required dependencies
class MockAtlasScope {
  public readonly id: string = "test-scope-123";
  public parentScopeId?: string;
  public supervisor?: unknown;
  public context: unknown = new MockContextManager();
  public memory: unknown = {};
  public messages: unknown = {};
  public prompts = { system: "", user: "" };
  public gates: unknown[] = [];

  newConversation() {
    return this.messages;
  }
  getConversation() {
    return this.messages;
  }
  archiveConversation() {}
  deleteConversation() {}
}

class MockContextManager {
  getContext(): unknown {
    return {};
  }
  setContext(_context: unknown): void {}
  clearContext(): void {}
}

class InMemoryStorageAdapter {
  private data = new Map<string, unknown>();

  async store(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
  }

  async retrieve(key: string): Promise<unknown> {
    return this.data.get(key) || null;
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }

  async list(): Promise<string[]> {
    return Array.from(this.data.keys());
  }

  async clear(): Promise<void> {
    this.data.clear();
  }

  async exists(key: string): Promise<boolean> {
    return this.data.has(key);
  }

  async commitByType(_type: unknown, _memories: unknown): Promise<void> {
    // In-memory storage doesn't need file commits
  }

  async commit(_memories: unknown): Promise<void> {}

  async load(): Promise<Map<string, unknown>> {
    return new Map(this.data);
  }

  async commitAll(_dataByType: unknown): Promise<void> {}

  async loadAll(): Promise<unknown> {
    return {};
  }
}

// Mock the file system dependencies that cause issues
const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;

// Mock timers to prevent actual intervals
globalThis.setInterval = () => 123;
globalThis.clearInterval = () => {};

// Mock console methods that don't work in this environment
const originalConsoleWarn = console.warn;
console.warn = () => {};

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

Deno.test("CoALAMemoryManager - basic instantiation", () => {
  const scope = new MockAtlasScope();
  const adapter = new InMemoryStorageAdapter();

  // Should be able to create without throwing
  const memory = createTestMemoryManager(scope, adapter);
  expect(memory).toBeDefined();
});

Deno.test("CoALAMemoryManager - remember and recall", () => {
  const scope = new MockAtlasScope();
  const adapter = new InMemoryStorageAdapter();

  const memory = createTestMemoryManager(scope, adapter);

  // Test basic remember/recall
  memory.rememberWithMetadata("test-key", "test-value", {
    memoryType: CoALAMemoryType.WORKING,
    tags: ["test-key"],
    relevanceScore: 0.8,
  });
  const recalled = memory.recall("test-key");

  expect(recalled).toBe("test-value");
});

Deno.test("CoALAMemoryManager - remember with metadata", () => {
  const scope = new MockAtlasScope();
  const adapter = new InMemoryStorageAdapter();

  const memory = createTestMemoryManager(scope, adapter);

  // Test remember with metadata
  memory.rememberWithMetadata("metadata-key", "metadata-value", {
    memoryType: CoALAMemoryType.SEMANTIC,
    tags: ["test", "metadata"],
    relevanceScore: 0.8,
    confidence: 0.9,
    decayRate: 0.1,
  });

  const recalled = memory.recall("metadata-key");
  expect(recalled).toBe("metadata-value");
});

Deno.test("CoALAMemoryManager - query memories", () => {
  const scope = new MockAtlasScope();
  const adapter = new InMemoryStorageAdapter();

  const memory = createTestMemoryManager(scope, adapter);

  // Add some memories
  memory.rememberWithMetadata("semantic-1", "semantic content 1", {
    memoryType: CoALAMemoryType.SEMANTIC,
    tags: ["test", "semantic"],
    relevanceScore: 0.8,
  });

  memory.rememberWithMetadata("working-1", "working content 1", {
    memoryType: CoALAMemoryType.WORKING,
    tags: ["test", "working"],
    relevanceScore: 0.7,
  });

  // Query by type
  const semanticMemories = memory.queryMemories({ memoryType: CoALAMemoryType.SEMANTIC });

  expect(semanticMemories).toHaveLength(1);
  expect(semanticMemories[0]?.content).toBe("semantic content 1");

  // Query by tags
  const taggedMemories = memory.queryMemories({ tags: ["semantic"] });

  expect(taggedMemories).toHaveLength(1);
  expect(taggedMemories[0]?.tags).toContain("semantic");
});

Deno.test("CoALAMemoryManager - get memories by type", () => {
  const scope = new MockAtlasScope();
  const adapter = new InMemoryStorageAdapter();

  const memory = createTestMemoryManager(scope, adapter);

  // Add memories of different types
  memory.rememberWithMetadata("episodic-1", "episodic content", {
    memoryType: CoALAMemoryType.EPISODIC,
    tags: ["episodic"],
    relevanceScore: 0.9,
  });

  memory.rememberWithMetadata("procedural-1", "procedural content", {
    memoryType: CoALAMemoryType.PROCEDURAL,
    tags: ["procedural"],
    relevanceScore: 0.8,
  });

  const episodicMemories = memory.getMemoriesByType(CoALAMemoryType.EPISODIC);
  const proceduralMemories = memory.getMemoriesByType(CoALAMemoryType.PROCEDURAL);

  expect(episodicMemories).toHaveLength(1);
  expect(proceduralMemories).toHaveLength(1);
  expect(episodicMemories[0]?.content).toBe("episodic content");
  expect(proceduralMemories[0]?.content).toBe("procedural content");
});

Deno.test("CoALAMemoryManager - forget memories", () => {
  const scope = new MockAtlasScope();
  const adapter = new InMemoryStorageAdapter();

  const memory = createTestMemoryManager(scope, adapter);

  // Add a memory
  memory.rememberWithMetadata("forget-me", "temporary content", {
    memoryType: CoALAMemoryType.WORKING,
    tags: ["forget-me"],
    relevanceScore: 0.8,
  });

  // Verify it exists
  let recalled = memory.recall("forget-me");
  expect(recalled).toBe("temporary content");

  // Forget it
  memory.forget("forget-me");

  // Verify it's gone
  recalled = memory.recall("forget-me");
  expect(recalled).toBeUndefined();
});

Deno.test("CoALAMemoryManager - cognitive loop methods", () => {
  const scope = new MockAtlasScope();
  const adapter = new InMemoryStorageAdapter();

  const memory = createTestMemoryManager(scope, adapter);

  // Add some memories for reflection
  memory.rememberWithMetadata("reflect-1", "reflection content 1", {
    memoryType: CoALAMemoryType.EPISODIC,
    tags: ["reflection"],
    relevanceScore: 0.8,
  });

  memory.rememberWithMetadata("reflect-2", "reflection content 2", {
    memoryType: CoALAMemoryType.SEMANTIC,
    tags: ["reflection"],
    relevanceScore: 0.9,
  });

  // Test cognitive loop methods - they should not throw
  expect(() => {
    const reflections = memory.reflect();
    expect(Array.isArray(reflections)).toBe(true);
  }).not.toThrow();

  expect(() => memory.consolidate()).not.toThrow();
  expect(() => memory.prune()).not.toThrow();
  expect(() => memory.adapt({ memoryId: "reflect-1", relevanceAdjustment: 0.1 })).not.toThrow();
});

Deno.test("CoALAMemoryManager - memory access patterns", () => {
  const scope = new MockAtlasScope();
  const adapter = new InMemoryStorageAdapter();

  const memory = createTestMemoryManager(scope, adapter);

  // Add a memory
  memory.rememberWithMetadata("access-test", "access content", {
    memoryType: CoALAMemoryType.WORKING,
    tags: ["access-test"],
    relevanceScore: 0.8,
  });

  // Access it multiple times
  memory.recall("access-test");
  memory.recall("access-test");
  memory.recall("access-test");

  // Get the memory to check access count
  const memories = memory.queryMemories({ content: "access content" });
  expect(memories).toHaveLength(1);
  expect(memories[0]?.accessCount).toBeGreaterThan(1);
});

Deno.test("CoALAMemoryManager - disposal", () => {
  const scope = new MockAtlasScope();
  const adapter = new InMemoryStorageAdapter();

  const memory = createTestMemoryManager(scope, adapter);

  // Add some memories
  memory.rememberWithMetadata("dispose-test-1", "content 1", {
    memoryType: CoALAMemoryType.WORKING,
    tags: ["dispose-test-1"],
    relevanceScore: 0.8,
  });
  memory.rememberWithMetadata("dispose-test-2", "content 2", {
    memoryType: CoALAMemoryType.WORKING,
    tags: ["dispose-test-2"],
    relevanceScore: 0.8,
  });

  // Dispose should not throw
  expect(memory.dispose()).resolves.not.toThrow();
});

// Cleanup after tests
Deno.test("Cleanup test environment", () => {
  // Restore original functions
  globalThis.setInterval = originalSetInterval;
  globalThis.clearInterval = originalClearInterval;
  console.warn = originalConsoleWarn;

  expect(true).toBe(true); // Just to make it a valid test
});
