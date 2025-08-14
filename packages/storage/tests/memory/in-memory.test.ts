// Set testing mode to disable file logging
Deno.env.set("DENO_TESTING", "true");

import { assertEquals, assertExists } from "@std/assert";
import { InMemoryStorageAdapter } from "../../src/memory/in-memory.ts";
import { CoALAMemoryType } from "@atlas/memory";

Deno.test("InMemoryStorageAdapter - should store and retrieve data", async () => {
  const adapter = new InMemoryStorageAdapter();

  const testData = {
    key1: { value: "test1", memoryType: CoALAMemoryType.WORKING },
    key2: { value: "test2", memoryType: CoALAMemoryType.SEMANTIC },
  };

  await adapter.commit(testData);
  const loaded = await adapter.load();

  assertEquals(loaded.key1.value, "test1");
  assertEquals(loaded.key2.value, "test2");
});

Deno.test("InMemoryStorageAdapter - should store and retrieve data by type", async () => {
  const adapter = new InMemoryStorageAdapter();

  const workingMemory = {
    task1: { description: "Current task", priority: 1 },
  };

  const semanticMemory = {
    fact1: { knowledge: "The sky is blue", confidence: 0.9 },
  };

  await adapter.commitByType("working", workingMemory);
  await adapter.commitByType("semantic", semanticMemory);

  const loadedWorking = await adapter.loadByType("working");
  const loadedSemantic = await adapter.loadByType("semantic");

  assertEquals(loadedWorking.task1.description, "Current task");
  assertEquals(loadedSemantic.fact1.knowledge, "The sky is blue");
});

Deno.test("InMemoryStorageAdapter - should list memory types", async () => {
  const adapter = new InMemoryStorageAdapter();

  await adapter.commitByType("working", { item: "data" });
  await adapter.commitByType("episodic", { event: "happened" });
  await adapter.commitByType("semantic", { fact: "known" });

  const types = await adapter.listMemoryTypes();

  assertEquals(types.length, 3);
  assertEquals(types.includes("working"), true);
  assertEquals(types.includes("episodic"), true);
  assertEquals(types.includes("semantic"), true);
});

Deno.test("InMemoryStorageAdapter - should clear all data", async () => {
  const adapter = new InMemoryStorageAdapter();

  await adapter.commitByType("working", { item: "data" });
  adapter.clear();

  const types = await adapter.listMemoryTypes();
  assertEquals(types.length, 0);

  const data = await adapter.load();
  assertEquals(Object.keys(data).length, 0);
});

Deno.test("InMemoryStorageAdapter - should handle empty data gracefully", async () => {
  const adapter = new InMemoryStorageAdapter();

  // Test loading empty data
  const data = await adapter.load();
  assertEquals(Object.keys(data).length, 0);

  // Test loading non-existent type
  const nonExistentData = await adapter.loadByType("nonexistent");
  assertEquals(Object.keys(nonExistentData).length, 0);

  // Test listing types when empty
  const types = await adapter.listMemoryTypes();
  assertEquals(types.length, 0);
});

Deno.test("InMemoryStorageAdapter - should handle data isolation", async () => {
  const adapter1 = new InMemoryStorageAdapter();
  const adapter2 = new InMemoryStorageAdapter();

  await adapter1.commitByType("working", { data: "adapter1" });
  await adapter2.commitByType("working", { data: "adapter2" });

  const data1 = await adapter1.loadByType("working");
  const data2 = await adapter2.loadByType("working");

  assertEquals(data1.data, "adapter1");
  assertEquals(data2.data, "adapter2");
});

Deno.test("InMemoryStorageAdapter - should support commitAll and loadAll", async () => {
  const adapter = new InMemoryStorageAdapter();

  const dataByType = {
    working: { task: "current task" },
    semantic: { fact: "important fact" },
    episodic: { event: "past event" },
  };

  await adapter.commitAll(dataByType);

  const loadedAll = await adapter.loadAll();
  assertEquals(loadedAll.working.task, "current task");
  assertEquals(loadedAll.semantic.fact, "important fact");
  assertEquals(loadedAll.episodic.event, "past event");
});

Deno.test("InMemoryStorageAdapter - should handle getAllData helper method", async () => {
  const adapter = new InMemoryStorageAdapter();

  const testData = {
    key1: { value: "test1", memoryType: CoALAMemoryType.WORKING },
    key2: { value: "test2", memoryType: CoALAMemoryType.SEMANTIC },
  };

  await adapter.commit(testData);

  const allData = adapter.getAllData();
  assertExists(allData.legacy);
  assertExists(allData.byType);
  assertEquals(allData.legacy.key1.value, "test1");
  assertEquals(allData.byType.working.key1.value, "test1");
});
