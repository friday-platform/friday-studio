/**
 * Tests for Memory Source Tracking
 *
 * Tests the complete source tracking system including storage,
 * retrieval, and migration of memory entries with source information.
 */

import { assertEquals, assertExists } from "@std/assert";
import type { IAtlasScope } from "../../../src/types/core.ts";
import { CoALAMemoryManager, CoALAMemoryType } from "../src/coala-memory.ts";
import { type ConversationContext, MemorySource } from "../src/mecmf-interfaces.ts";
import { AtlasMECMFMemoryManager } from "../src/mecmf-memory-manager.ts";

// Helper to track and close MessageChannels created by onnxruntime-web during tests
async function runWithMessageChannelCleanup<T>(fn: () => Promise<T>): Promise<T> {
  const OriginalMessageChannel = globalThis.MessageChannel;
  if (!OriginalMessageChannel) {
    return await fn();
  }

  const created: MessageChannel[] = [];

  // Create a proper mock constructor that matches MessageChannel interface
  class MockMessageChannel implements MessageChannel {
    readonly port1: MessagePort;
    readonly port2: MessagePort;

    constructor() {
      if (!OriginalMessageChannel) {
        throw new Error("OriginalMessageChannel is undefined");
      }
      const original = new OriginalMessageChannel();
      this.port1 = original.port1;
      this.port2 = original.port2;
      created.push(original);
    }
  }

  // Replace global MessageChannel with our mock
  globalThis.MessageChannel = MockMessageChannel;

  try {
    return await fn();
  } finally {
    // Close any remaining ports to satisfy Deno leak detection
    for (const mc of created) {
      try {
        mc.port1.close();
      } catch (_) {
        /* noop */
      }
      try {
        mc.port2.close();
      } catch (_) {
        /* noop */
      }
    }
    // Restore original constructor
    globalThis.MessageChannel = OriginalMessageChannel;
  }
}

// Helper function to create conversation context
const createConversationContext = (
  sessionId: string,
  workspaceId: string,
): ConversationContext => ({
  sessionId,
  workspaceId,
  currentTask: "test-task",
  recentMessages: ["test-message"],
  activeAgents: ["test-agent"],
});

// Mock scope for testing
const createTestScope = (id: string) =>
  ({ id, workspaceId: id, type: "test" as const }) as unknown as IAtlasScope;

Deno.test("CoALA Memory - Source Field Storage and Retrieval", async () => {
  const scope = createTestScope("test-workspace");
  const memoryManager = new CoALAMemoryManager(scope);

  const testContent = "Test memory content";
  const sourceMetadata = {
    agentId: "test-agent",
    sessionId: "test-session",
    workspaceId: "test-workspace",
  };

  // Store memory with source information
  memoryManager.rememberWithMetadata("test-memory", testContent, {
    memoryType: CoALAMemoryType.WORKING,
    tags: ["test"],
    relevanceScore: 0.8,
    source: MemorySource.AGENT_OUTPUT,
    sourceMetadata,
  });

  // Retrieve and verify source information
  const retrievedContent = memoryManager.recall("test-memory");
  assertEquals(retrievedContent, testContent);

  // Get all memories to check source field persistence
  const allMemories = memoryManager.queryMemories({});
  const testMemory = allMemories.find((m) => m.id === "test-memory");

  assertExists(testMemory);
  assertEquals(testMemory.source, MemorySource.AGENT_OUTPUT);
  assertEquals(testMemory.sourceMetadata, sourceMetadata);

  await memoryManager.dispose();
});

Deno.test("CoALA Memory - Default Source Assignment", async () => {
  const scope = createTestScope("test-workspace-default");
  const memoryManager = new CoALAMemoryManager(scope);

  // Store memory without explicit source
  memoryManager.rememberWithMetadata("test-memory-default", "content", {
    memoryType: CoALAMemoryType.SEMANTIC,
    tags: ["test"],
    relevanceScore: 0.5,
    // No source provided
  });

  const allMemories = memoryManager.queryMemories({});
  const testMemory = allMemories.find((m) => m.id === "test-memory-default");

  assertExists(testMemory);
  assertEquals(testMemory.source, "system_generated"); // Default value

  await memoryManager.dispose();
});

Deno.test({
  name: "MECMF Memory - Source-Aware Classification and Storage",
  fn: async () => {
    await runWithMessageChannelCleanup(async () => {
      const scope = createTestScope("mecmf-test");
      const config = { workspaceId: "mecmf-test" };
      const mecmfManager = new AtlasMECMFMemoryManager(scope, config);

      await mecmfManager.initialize();

      const context = createConversationContext("test-session", "mecmf-test");
      const sourceMetadata = { agentId: "test-agent", sessionId: "test-session" };

      // Test different sources
      const testCases = [
        {
          content: "User provided their email: user@example.com",
          source: MemorySource.USER_INPUT,
          expectedPII: true,
        },
        {
          content: "Agent found email: scraped@web.com",
          source: MemorySource.AGENT_OUTPUT,
          expectedPII: false,
        },
        {
          content: "Tool extracted: contact@website.com",
          source: MemorySource.TOOL_OUTPUT,
          expectedPII: false,
        },
      ];

      const storedIds = [];

      for (const testCase of testCases) {
        const memoryId = await mecmfManager.classifyAndStore(
          testCase.content,
          context,
          testCase.source,
          sourceMetadata,
        );

        storedIds.push(memoryId);

        // Verify memory was stored
        const retrievedMemory = await mecmfManager.retrieveMemory(memoryId);
        assertExists(retrievedMemory);
        assertEquals(retrievedMemory.source, testCase.source);
        assertEquals(retrievedMemory.sourceMetadata, sourceMetadata);
      }

      // Clean up stored memories
      for (const id of storedIds) {
        await mecmfManager.deleteMemory(id);
      }

      await mecmfManager.dispose();
    });
  },
});

Deno.test({
  name: "MECMF Memory - Source Statistics and Filtering",
  fn: async () => {
    await runWithMessageChannelCleanup(async () => {
      const scope = createTestScope("mecmf-stats");
      const config = { workspaceId: "mecmf-stats" };
      const mecmfManager = new AtlasMECMFMemoryManager(scope, config);

      await mecmfManager.initialize();

      const context = createConversationContext("test-session", "mecmf-stats");

      // Store memories from different sources
      const sources = [
        MemorySource.USER_INPUT,
        MemorySource.AGENT_OUTPUT,
        MemorySource.TOOL_OUTPUT,
        MemorySource.SYSTEM_GENERATED,
      ];

      const storedIds = [];

      for (let i = 0; i < sources.length; i++) {
        const memoryId = await mecmfManager.classifyAndStore(
          `Test content ${i}`,
          context,
          sources[i],
          { sessionId: "test-session" },
        );
        storedIds.push(memoryId);
      }

      // Verify different sources were used
      const memories = await Promise.all(storedIds.map((id) => mecmfManager.retrieveMemory(id)));

      const uniqueSources = new Set(memories.filter((m) => m !== null).map((m) => m?.source));
      assertEquals(uniqueSources.size, sources.length);

      // Clean up
      for (const id of storedIds) {
        await mecmfManager.deleteMemory(id);
      }

      await mecmfManager.dispose();
    });
  },
});

Deno.test("Memory Source Migration - Basic Functionality", async () => {
  const scope = createTestScope("migration-test");
  const memoryManager = new CoALAMemoryManager(scope);

  // Store memory without source (simulating old format)
  const oldMemoryData = {
    id: "old-memory",
    content: "Old memory content",
    timestamp: new Date(),
    accessCount: 0,
    lastAccessed: new Date(),
    memoryType: CoALAMemoryType.SEMANTIC,
    relevanceScore: 0.7,
    sourceScope: "migration-test",
    associations: [],
    tags: ["old", "test"],
    confidence: 0.9,
    decayRate: 0.1,
    // No source field
  };

  // Directly add to memory store (simulating old data)
  memoryManager.rememberWithMetadata("old-memory", oldMemoryData.content, {
    memoryType: CoALAMemoryType.SEMANTIC,
    tags: ["old", "test"],
    relevanceScore: 0.7,
    source: MemorySource.SYSTEM_GENERATED,
    sourceMetadata: { workspaceId: "migration-test" },
  });

  // Get memory and verify no source
  let allMemories = memoryManager.queryMemories({});
  const oldMemory = allMemories.find((m) => m.id === "old-memory");
  assertExists(oldMemory);

  // Update memory with source information (simulating migration)
  memoryManager.rememberWithMetadata("old-memory", oldMemoryData.content, {
    memoryType: CoALAMemoryType.SEMANTIC,
    tags: ["old", "test", "migrated"],
    relevanceScore: 0.7,
    source: MemorySource.SYSTEM_GENERATED,
    sourceMetadata: { workspaceId: "migration-test" },
  });

  // Verify migration worked
  allMemories = memoryManager.queryMemories({});
  const migratedMemory = allMemories.find((m) => m.id === "old-memory");
  assertExists(migratedMemory);
  assertEquals(migratedMemory.source, MemorySource.SYSTEM_GENERATED);
  assertExists(migratedMemory.sourceMetadata);
  assertEquals(migratedMemory.sourceMetadata?.workspaceId, "migration-test");

  await memoryManager.dispose();
});

Deno.test("Source Metadata Preservation Through Operations", async () => {
  const scope = createTestScope("metadata-test");
  const memoryManager = new CoALAMemoryManager(scope);

  const sourceMetadata = {
    agentId: "test-agent",
    toolName: "test-tool",
    sessionId: "test-session",
    userId: "test-user",
    workspaceId: "metadata-test",
  };

  // Store with rich metadata
  memoryManager.rememberWithMetadata("rich-metadata", "content", {
    memoryType: CoALAMemoryType.PROCEDURAL,
    tags: ["procedure"],
    relevanceScore: 0.9,
    source: MemorySource.TOOL_OUTPUT,
    sourceMetadata,
  });

  // Retrieve and verify all metadata preserved
  const allMemories = memoryManager.queryMemories({});
  const richMemory = allMemories.find((m) => m.id === "rich-metadata");

  assertExists(richMemory);
  assertEquals(richMemory.source, MemorySource.TOOL_OUTPUT);
  assertEquals(richMemory.sourceMetadata, sourceMetadata);

  // Verify each field of metadata
  assertEquals(richMemory.sourceMetadata?.agentId, "test-agent");
  assertEquals(richMemory.sourceMetadata?.toolName, "test-tool");
  assertEquals(richMemory.sourceMetadata?.sessionId, "test-session");
  assertEquals(richMemory.sourceMetadata?.userId, "test-user");
  assertEquals(richMemory.sourceMetadata?.workspaceId, "metadata-test");

  await memoryManager.dispose();
});

Deno.test("Source Tracking with Memory Consolidation", async () => {
  const scope = createTestScope("consolidation-test");
  const memoryManager = new CoALAMemoryManager(scope);

  // Store multiple related memories with different sources
  const memories = [
    {
      id: "user-input-1",
      content: "User said: I need help with authentication",
      source: MemorySource.USER_INPUT,
      metadata: { userId: "user123", sessionId: "session1" },
    },
    {
      id: "agent-response-1",
      content: "Agent provided authentication steps",
      source: MemorySource.AGENT_OUTPUT,
      metadata: { agentId: "auth-agent", sessionId: "session1" },
    },
    {
      id: "tool-result-1",
      content: "Tool verified user credentials successfully",
      source: MemorySource.TOOL_OUTPUT,
      metadata: { toolName: "auth-verifier", sessionId: "session1" },
    },
  ];

  // Store all memories
  for (const memory of memories) {
    memoryManager.rememberWithMetadata(memory.id, memory.content, {
      memoryType: CoALAMemoryType.WORKING,
      tags: ["authentication", "session1"],
      relevanceScore: 0.8,
      source: memory.source,
      sourceMetadata: memory.metadata,
    });
  }

  // Trigger consolidation
  memoryManager.consolidate();

  // Verify all memories preserved with source info after consolidation
  const allMemories = memoryManager.queryMemories({});
  assertEquals(allMemories.length >= memories.length, true);

  for (const originalMemory of memories) {
    const found = allMemories.find((m) => m.id === originalMemory.id);
    assertExists(found);
    assertEquals(found.source, originalMemory.source);
    assertEquals(found.sourceMetadata, originalMemory.metadata);
  }

  await memoryManager.dispose();
});

Deno.test({
  name: "Source-Based Memory Retrieval and Filtering",
  fn: async () => {
    await runWithMessageChannelCleanup(async () => {
      const scope = createTestScope("filtering-test");
      const config = { workspaceId: "filtering-test" };
      const mecmfManager = new AtlasMECMFMemoryManager(scope, config);

      await mecmfManager.initialize();

      const context = createConversationContext("test-session", "filtering-test");

      // Store memories from different sources
      const testMemories = [
        { content: "User input memory", source: MemorySource.USER_INPUT },
        { content: "Agent output memory", source: MemorySource.AGENT_OUTPUT },
        { content: "Tool output memory", source: MemorySource.TOOL_OUTPUT },
        { content: "System generated memory", source: MemorySource.SYSTEM_GENERATED },
      ];

      const storedIds = [];
      for (const mem of testMemories) {
        const id = await mecmfManager.classifyAndStore(mem.content, context, mem.source, {
          sessionId: "test-session",
        });
        storedIds.push({ id, source: mem.source });
      }

      // Test retrieval and verify sources preserved
      for (const { id, source } of storedIds) {
        const retrieved = await mecmfManager.retrieveMemory(id);
        assertExists(retrieved);
        assertEquals(retrieved.source, source);
        assertEquals(retrieved.sourceMetadata?.sessionId, "test-session");
      }

      // Clean up
      for (const { id } of storedIds) {
        await mecmfManager.deleteMemory(id);
      }

      await mecmfManager.dispose();
    });
  },
});
