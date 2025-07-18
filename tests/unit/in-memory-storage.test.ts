// Set testing mode to disable file logging
Deno.env.set("DENO_TESTING", "true");

import { assertEquals, assertExists } from "@std/assert";
import { InMemoryStorageAdapter } from "@atlas/storage";
import {
  createTestScope,
  createTestSession,
  MockAgent,
  MockSignal,
} from "../../src/testing/helpers.ts";
import { CoALAMemoryType } from "@atlas/memory";

Deno.test("InMemoryStorageAdapter - should store and retrieve data", async () => {
  const adapter = new InMemoryStorageAdapter();

  const testData = {
    key1: { value: "test1", memoryType: "working" },
    key2: { value: "test2", memoryType: "semantic" },
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

Deno.test("AtlasScope with InMemoryStorage - should use in-memory storage when provided", async () => {
  const { scope, storage } = createTestScope();

  // Add some memory
  scope.memory.remember("test-key", "test-value");

  // Check that data is stored in the in-memory adapter
  const allData = storage.getAllData();
  assertExists(allData);

  // The memory manager might organize data by type
  const types = await storage.listMemoryTypes();
  assertEquals(types.length > 0, true);
});

Deno.test("AtlasScope with InMemoryStorage - should support CoALA memory operations", async () => {
  const { scope, storage } = createTestScope();

  // Use CoALA-specific memory operations
  const memory = scope.memory as any; // Cast to access CoALA methods

  memory.rememberWithMetadata(
    "important-fact",
    { fact: "Testing is important" },
    {
      memoryType: CoALAMemoryType.SEMANTIC,
      tags: ["testing", "best-practices"],
      relevanceScore: 0.9,
      confidence: 1.0,
    },
  );

  // Check storage
  const semanticData = await storage.loadByType("semantic");
  assertExists(semanticData["important-fact"]);
  assertEquals(semanticData["important-fact"].content.fact, "Testing is important");
});

Deno.test("Session with InMemoryStorage - should create session with in-memory storage", async () => {
  const mockSignal = new MockSignal("test-signal", "test-provider");
  const mockAgent = new MockAgent("test-agent", "Test Agent");

  const { session, storage } = createTestSession(
    "test-workspace",
    {
      triggers: [mockSignal],
      callback: {
        onSuccess: () => {},
        onError: () => {},
        onComplete: () => {},
        execute: () => {},
        validate: () => true,
      },
    },
    [mockAgent],
  );

  assertExists(session);
  assertExists(storage);

  // Session should use the in-memory storage
  session.memory.remember("session-data", { status: "initialized" });

  const data = await storage.load();
  assertExists(data["session-data"]);
});

Deno.test("Session with InMemoryStorage - should preserve memory across session lifecycle", async () => {
  const mockSignal = new MockSignal();
  const { session, storage } = createTestSession(
    "test-workspace",
    {
      triggers: [mockSignal],
      callback: {
        onSuccess: (result) => {
          // Store result in memory
          session.memory.remember("result", result);
        },
        onError: () => {},
        onComplete: () => {},
        execute: () => {},
        validate: () => true,
      },
    },
  );

  // Start the session
  await session.start();

  // Check that initialization data was stored
  const types = await storage.listMemoryTypes();
  assertEquals(types.includes("contextual"), true);

  // Check session state
  assertEquals(session.status, "completed");
});

Deno.test("Session with InMemoryStorage - should support memory isolation between sessions", async () => {
  const storage1 = new InMemoryStorageAdapter();
  const storage2 = new InMemoryStorageAdapter();

  const signal1 = new MockSignal();
  const signal2 = new MockSignal();

  const session1 = new Session(
    "workspace1",
    {
      triggers: [signal1],
      callback: {
        onSuccess: () => {},
        onError: () => {},
        onComplete: () => {},
        execute: () => {},
        validate: () => true,
      },
    },
    undefined,
    undefined,
    undefined,
    undefined,
    storage1,
    false, // Disable cognitive loop
  );

  const session2 = new Session(
    "workspace2",
    {
      triggers: [signal2],
      callback: {
        onSuccess: () => {},
        onError: () => {},
        onComplete: () => {},
        execute: () => {},
        validate: () => true,
      },
    },
    undefined,
    undefined,
    undefined,
    undefined,
    storage2,
    false, // Disable cognitive loop
  );

  // Add different data to each session
  session1.memory.remember("data", "session1-data");
  session2.memory.remember("data", "session2-data");

  // Each session has its own memory
  const data1 = session1.memory.recall("data");
  const data2 = session2.memory.recall("data");

  assertEquals(data1, "session1-data");
  assertEquals(data2, "session2-data");
});

// Import Session class for the last test
import { Session } from "../../src/core/session.ts";
