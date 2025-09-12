// Set testing mode to disable file logging
Deno.env.set("DENO_TESTING", "true");

import { MemorySource, MemoryType } from "@atlas/memory";
import { assertEquals, assertExists } from "@std/assert";
import { InMemoryStorageAdapter } from "../../src/memory/in-memory.ts";

Deno.test("InMemoryStorageAdapter - should store and retrieve data", async () => {
  const adapter = new InMemoryStorageAdapter();

  const testData = {
    working: [
      {
        id: "entry1",
        content: "test1",
        timestamp: new Date(),
        memoryType: MemoryType.WORKING,
        relevanceScore: 0.8,
        sourceScope: "test-scope",
        tags: ["test"],
        confidence: 0.9,
        decayRate: 0.1,
        source: MemorySource.USER_INPUT,
      },
    ],
    semantic: [
      {
        id: "entry2",
        content: "test2",
        timestamp: new Date(),
        memoryType: MemoryType.SEMANTIC,
        relevanceScore: 0.7,
        sourceScope: "test-scope",
        tags: ["test"],
        confidence: 0.8,
        decayRate: 0.05,
        source: MemorySource.USER_INPUT,
      },
    ],
  };

  await adapter.commitAll(testData);
  const loaded = await adapter.loadAll();

  assertEquals(loaded.working?.[0]?.content, "test1");
  assertEquals(loaded.semantic?.[0]?.content, "test2");
});

Deno.test("InMemoryStorageAdapter - should store and retrieve data by type", async () => {
  const adapter = new InMemoryStorageAdapter();

  const workingMemory = [
    {
      id: "task1",
      content: "Current task",
      timestamp: new Date(),
      memoryType: MemoryType.WORKING,
      relevanceScore: 0.8,
      sourceScope: "test-scope",
      tags: ["task"],
      confidence: 0.9,
      decayRate: 0.1,
      source: MemorySource.USER_INPUT,
    },
  ];

  const semanticMemory = [
    {
      id: "fact1",
      content: "The sky is blue",
      timestamp: new Date(),
      memoryType: MemoryType.SEMANTIC,
      relevanceScore: 0.9,
      sourceScope: "test-scope",
      tags: ["fact"],
      confidence: 0.9,
      decayRate: 0.05,
      source: MemorySource.USER_INPUT,
    },
  ];

  await adapter.commitByType("working", workingMemory);
  await adapter.commitByType("semantic", semanticMemory);

  const loadedWorking = await adapter.loadByType("working");
  const loadedSemantic = await adapter.loadByType("semantic");

  assertEquals(loadedWorking[0]?.content, "Current task");
  assertEquals(loadedSemantic[0]?.content, "The sky is blue");
});

Deno.test("InMemoryStorageAdapter - should list memory types", async () => {
  const adapter = new InMemoryStorageAdapter();

  await adapter.commitByType("working", [
    {
      id: "item1",
      content: "data",
      timestamp: new Date(),
      memoryType: MemoryType.WORKING,
      relevanceScore: 0.7,
      sourceScope: "test-scope",
      tags: [],
      confidence: 0.8,
      decayRate: 0.1,
      source: MemorySource.SYSTEM_GENERATED,
    },
  ]);

  await adapter.commitByType("episodic", [
    {
      id: "event1",
      content: "happened",
      timestamp: new Date(),
      memoryType: MemoryType.EPISODIC,
      relevanceScore: 0.6,
      sourceScope: "test-scope",
      tags: [],
      confidence: 0.7,
      decayRate: 0.2,
      source: MemorySource.SYSTEM_GENERATED,
    },
  ]);

  await adapter.commitByType("semantic", [
    {
      id: "fact1",
      content: "known",
      timestamp: new Date(),
      memoryType: MemoryType.SEMANTIC,
      relevanceScore: 0.8,
      sourceScope: "test-scope",
      tags: [],
      confidence: 0.9,
      decayRate: 0.05,
      source: MemorySource.SYSTEM_GENERATED,
    },
  ]);

  const types = await adapter.listMemoryTypes();

  assertEquals(types.length, 3);
  assertEquals(types.includes("working"), true);
  assertEquals(types.includes("episodic"), true);
  assertEquals(types.includes("semantic"), true);
});

Deno.test("InMemoryStorageAdapter - should clear all data", async () => {
  const adapter = new InMemoryStorageAdapter();

  await adapter.commitByType("working", [
    {
      id: "item1",
      content: "data",
      timestamp: new Date(),
      memoryType: MemoryType.WORKING,
      relevanceScore: 0.7,
      sourceScope: "test-scope",
      tags: [],
      confidence: 0.8,
      decayRate: 0.1,
      source: MemorySource.SYSTEM_GENERATED,
    },
  ]);
  adapter.clear();

  const types = await adapter.listMemoryTypes();
  assertEquals(types.length, 0);

  const data = await adapter.loadAll();
  assertEquals(Object.keys(data).length, 0);
});

Deno.test("InMemoryStorageAdapter - should handle empty data gracefully", async () => {
  const adapter = new InMemoryStorageAdapter();

  // Test loading empty data
  const data = await adapter.loadAll();
  assertEquals(Object.keys(data).length, 0);

  // Test loading non-existent type
  const nonExistentData = await adapter.loadByType("nonexistent");
  assertEquals(nonExistentData.length, 0);

  // Test listing types when empty
  const types = await adapter.listMemoryTypes();
  assertEquals(types.length, 0);
});

Deno.test("InMemoryStorageAdapter - should handle data isolation", async () => {
  const adapter1 = new InMemoryStorageAdapter();
  const adapter2 = new InMemoryStorageAdapter();

  await adapter1.commitByType("working", [
    {
      id: "data1",
      content: "adapter1",
      timestamp: new Date(),
      memoryType: MemoryType.WORKING,
      relevanceScore: 0.8,
      sourceScope: "test-scope",
      tags: [],
      confidence: 0.9,
      decayRate: 0.1,
      source: MemorySource.SYSTEM_GENERATED,
    },
  ]);

  await adapter2.commitByType("working", [
    {
      id: "data2",
      content: "adapter2",
      timestamp: new Date(),
      memoryType: MemoryType.WORKING,
      relevanceScore: 0.8,
      sourceScope: "test-scope",
      tags: [],
      confidence: 0.9,
      decayRate: 0.1,
      source: MemorySource.SYSTEM_GENERATED,
    },
  ]);

  const data1 = await adapter1.loadByType("working");
  const data2 = await adapter2.loadByType("working");

  assertEquals(data1[0]?.content, "adapter1");
  assertEquals(data2[0]?.content, "adapter2");
});

Deno.test("InMemoryStorageAdapter - should support commitAll and loadAll", async () => {
  const adapter = new InMemoryStorageAdapter();

  const dataByType = {
    working: [
      {
        id: "task1",
        content: "current task",
        timestamp: new Date(),
        memoryType: MemoryType.WORKING,
        relevanceScore: 0.8,
        sourceScope: "test-scope",
        tags: ["task"],
        confidence: 0.9,
        decayRate: 0.1,
        source: MemorySource.USER_INPUT,
      },
    ],
    semantic: [
      {
        id: "fact1",
        content: "important fact",
        timestamp: new Date(),
        memoryType: MemoryType.SEMANTIC,
        relevanceScore: 0.9,
        sourceScope: "test-scope",
        tags: ["fact"],
        confidence: 0.95,
        decayRate: 0.05,
        source: MemorySource.USER_INPUT,
      },
    ],
    episodic: [
      {
        id: "event1",
        content: "past event",
        timestamp: new Date(),
        memoryType: MemoryType.EPISODIC,
        relevanceScore: 0.7,
        sourceScope: "test-scope",
        tags: ["event"],
        confidence: 0.8,
        decayRate: 0.15,
        source: MemorySource.USER_INPUT,
      },
    ],
  };

  await adapter.commitAll(dataByType);

  const loadedAll = await adapter.loadAll();
  assertEquals(loadedAll.working?.[0]?.content, "current task");
  assertEquals(loadedAll.semantic?.[0]?.content, "important fact");
  assertEquals(loadedAll.episodic?.[0]?.content, "past event");
});

Deno.test("InMemoryStorageAdapter - should handle getAllData helper method", async () => {
  const adapter = new InMemoryStorageAdapter();

  const testData = {
    working: [
      {
        id: "entry1",
        content: "test1",
        timestamp: new Date(),
        memoryType: MemoryType.WORKING,
        relevanceScore: 0.8,
        sourceScope: "test-scope",
        tags: ["test"],
        confidence: 0.9,
        decayRate: 0.1,
        source: MemorySource.USER_INPUT,
      },
    ],
    semantic: [
      {
        id: "entry2",
        content: "test2",
        timestamp: new Date(),
        memoryType: MemoryType.SEMANTIC,
        relevanceScore: 0.7,
        sourceScope: "test-scope",
        tags: ["test"],
        confidence: 0.8,
        decayRate: 0.05,
        source: MemorySource.USER_INPUT,
      },
    ],
  };

  await adapter.commitAll(testData);

  const allData = adapter.getAllData();
  assertExists(allData.legacy);
  assertExists(allData.byType);
  assertEquals(allData.byType.working?.[0]?.content, "test1");
});
