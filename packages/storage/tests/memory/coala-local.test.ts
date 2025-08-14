// Set testing mode to disable file logging
Deno.env.set("DENO_TESTING", "true");

import { assertEquals, assertExists } from "@std/assert";
import { join } from "@std/path";
import { CoALALocalFileStorageAdapter } from "../../src/memory/coala-local.ts";
import { CoALAMemoryType } from "@atlas/memory";

// Helper function to create temporary directory for tests
async function createTempDir(): Promise<string> {
  const tempDir = await Deno.makeTempDir({ prefix: "atlas_storage_test_" });
  return tempDir;
}

// Helper function to cleanup temporary directory
async function cleanupTempDir(path: string): Promise<void> {
  try {
    await Deno.remove(path, { recursive: true });
  } catch {
    // Ignore errors if directory doesn't exist
  }
}

Deno.test("CoALALocalFileStorageAdapter - should store and retrieve data", async () => {
  const tempDir = await createTempDir();
  const adapter = new CoALALocalFileStorageAdapter(tempDir);

  try {
    const testData = {
      key1: { value: "test1", memoryType: CoALAMemoryType.WORKING },
      key2: { value: "test2", memoryType: CoALAMemoryType.SEMANTIC },
    };

    await adapter.commit(testData);
    const loaded = await adapter.load();

    assertEquals(loaded.key1.value, "test1");
    assertEquals(loaded.key2.value, "test2");
  } finally {
    await cleanupTempDir(tempDir);
  }
});

Deno.test("CoALALocalFileStorageAdapter - should store data by memory type", async () => {
  const tempDir = await createTempDir();
  const adapter = new CoALALocalFileStorageAdapter(tempDir);

  try {
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

    // Check that files were created
    const workingFile = join(tempDir, "working.json");
    const semanticFile = join(tempDir, "semantic.json");
    const workingExists = await Deno.stat(workingFile).then(() => true).catch(() => false);
    const semanticExists = await Deno.stat(semanticFile).then(() => true).catch(() => false);

    assertEquals(workingExists, true);
    assertEquals(semanticExists, true);
  } finally {
    await cleanupTempDir(tempDir);
  }
});

Deno.test("CoALALocalFileStorageAdapter - should list memory types", async () => {
  const tempDir = await createTempDir();
  const adapter = new CoALALocalFileStorageAdapter(tempDir);

  try {
    await adapter.commitByType("working", { item: "data" });
    await adapter.commitByType("episodic", { event: "happened" });
    await adapter.commitByType("semantic", { fact: "known" });

    const types = await adapter.listMemoryTypes();

    assertEquals(types.length >= 3, true);
    assertEquals(types.includes("working"), true);
    assertEquals(types.includes("episodic"), true);
    assertEquals(types.includes("semantic"), true);
  } finally {
    await cleanupTempDir(tempDir);
  }
});

Deno.test("CoALALocalFileStorageAdapter - should create index file", async () => {
  const tempDir = await createTempDir();
  const adapter = new CoALALocalFileStorageAdapter(tempDir);

  try {
    const dataByType = {
      working: { task: "current task" },
      semantic: { fact: "important fact" },
    };

    await adapter.commitAll(dataByType);

    // Check that index file was created
    const indexFile = join(tempDir, "index.json");
    const indexExists = await Deno.stat(indexFile).then(() => true).catch(() => false);
    assertEquals(indexExists, true);

    // Check index content
    const indexContent = await Deno.readTextFile(indexFile);
    const index = JSON.parse(indexContent);
    assertExists(index.lastUpdated);
    assertExists(index.memoryTypes);
    assertExists(index.memoryTypes.working);
    assertExists(index.memoryTypes.semantic);
  } finally {
    await cleanupTempDir(tempDir);
  }
});

Deno.test("CoALALocalFileStorageAdapter - should handle empty files gracefully", async () => {
  const tempDir = await createTempDir();
  const adapter = new CoALALocalFileStorageAdapter(tempDir);

  try {
    // Create empty file
    const emptyFile = join(tempDir, "empty.json");
    await Deno.writeTextFile(emptyFile, "");

    // Should return empty object for empty file
    const data = await adapter.loadByType("empty");
    assertEquals(Object.keys(data).length, 0);
  } finally {
    await cleanupTempDir(tempDir);
  }
});

Deno.test("CoALALocalFileStorageAdapter - should handle corrupted JSON gracefully", async () => {
  const tempDir = await createTempDir();
  const adapter = new CoALALocalFileStorageAdapter(tempDir);

  try {
    // Create corrupted JSON file
    const corruptedFile = join(tempDir, "corrupted.json");
    await Deno.writeTextFile(corruptedFile, "{invalid json}");

    // Should return empty object for corrupted file
    const data = await adapter.loadByType("corrupted");
    assertEquals(Object.keys(data).length, 0);
  } finally {
    await cleanupTempDir(tempDir);
  }
});

Deno.test("CoALALocalFileStorageAdapter - should get memory statistics", async () => {
  const tempDir = await createTempDir();
  const adapter = new CoALALocalFileStorageAdapter(tempDir);

  try {
    const dataByType = {
      working: {
        task1: { description: "task", relevanceScore: 0.8, timestamp: new Date() },
        task2: { description: "task2", relevanceScore: 0.9, timestamp: new Date() },
      },
      semantic: {
        fact1: { knowledge: "fact", relevanceScore: 0.95, timestamp: new Date() },
      },
    };

    await adapter.commitAll(dataByType);

    const stats = await adapter.getMemoryStatistics();
    assertExists(stats.lastUpdated);
    assertExists(stats.memoryTypes);
    assertEquals(stats.memoryTypes.working.count, 2);
    assertEquals(stats.memoryTypes.semantic.count, 1);
  } finally {
    await cleanupTempDir(tempDir);
  }
});

Deno.test("CoALALocalFileStorageAdapter - should compact memory types", async () => {
  const tempDir = await createTempDir();
  const adapter = new CoALALocalFileStorageAdapter(tempDir);

  try {
    const workingMemory = {
      highRelevance: { description: "important", relevanceScore: 0.9 },
      lowRelevance: { description: "unimportant", relevanceScore: 0.05 },
    };

    await adapter.commitByType("working", workingMemory);
    await adapter.compactMemoryType("working");

    const compactedData = await adapter.loadByType("working");
    assertExists(compactedData.highRelevance);
    assertEquals(compactedData.lowRelevance, undefined);
  } finally {
    await cleanupTempDir(tempDir);
  }
});

Deno.test("CoALALocalFileStorageAdapter - should handle non-existent directory", async () => {
  const nonExistentDir = "/tmp/non-existent-dir-" + Date.now();
  const adapter = new CoALALocalFileStorageAdapter(nonExistentDir);

  try {
    // Should return empty object for non-existent directory
    const data = await adapter.loadByType("working");
    assertEquals(Object.keys(data).length, 0);

    // Should create directory when storing data
    await adapter.commitByType("working", { task: "test" });
    const loadedData = await adapter.loadByType("working");
    assertEquals(loadedData.task, "test");
  } finally {
    await cleanupTempDir(nonExistentDir);
  }
});
