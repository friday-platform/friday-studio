// Set testing mode to disable file logging
Deno.env.set("DENO_TESTING", "true");

import { assertEquals } from "@std/assert";
import { CoALALocalFileStorageAdapter } from "../../src/memory/coala-local.ts";

async function createTempDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "atlas_storage_test_" });
}

async function cleanupTempDir(path: string): Promise<void> {
  try {
    await Deno.remove(path, { recursive: true });
  } catch {
    // Ignore cleanup errors
  }
}

Deno.test("CoALALocalFileStorageAdapter - should write files sequentially not concurrently", async () => {
  const tempDir = await createTempDir();
  const adapter = new CoALALocalFileStorageAdapter(tempDir);

  // Track concurrent writes
  let concurrentWrites = 0;
  let maxConcurrent = 0;
  const writeStartTimes: number[] = [];
  const writeEndTimes: number[] = [];

  // Override writeTextFile to track concurrency
  const originalWriteTextFile = Deno.writeTextFile;
  Deno.writeTextFile = async (path, data, options) => {
    const startTime = Date.now();
    writeStartTimes.push(startTime);

    concurrentWrites++;
    maxConcurrent = Math.max(maxConcurrent, concurrentWrites);

    // Simulate some write delay
    await new Promise((resolve) => setTimeout(resolve, 10));

    const result = await originalWriteTextFile(path, data, options);

    concurrentWrites--;
    writeEndTimes.push(Date.now());

    return result;
  };

  try {
    // Write multiple memory types
    await adapter.commitAll({
      working: { item1: { data: "test1" }, item2: { data: "test2" } },
      episodic: { item3: { data: "test3" }, item4: { data: "test4" } },
      semantic: { item5: { data: "test5" }, item6: { data: "test6" } },
      procedural: { item7: { data: "test7" }, item8: { data: "test8" } },
    });

    // Verify sequential execution
    assertEquals(maxConcurrent, 1, "Files should be written sequentially, not concurrently");

    // Verify write ordering (each write should start after the previous one ends)
    for (let i = 1; i < writeStartTimes.length; i++) {
      const prevEndTime = writeEndTimes[i - 1];
      const currentStartTime = writeStartTimes[i];

      // Allow 1ms tolerance for timing precision
      const isSequential = currentStartTime! >= prevEndTime! - 1;
      assertEquals(isSequential, true, `Write ${i} should start after write ${i - 1} completes`);
    }
  } finally {
    // Restore original function
    Deno.writeTextFile = originalWriteTextFile;
    await cleanupTempDir(tempDir);
  }
});

Deno.test("CoALALocalFileStorageAdapter - should compact memory types sequentially", async () => {
  const tempDir = await createTempDir();
  const adapter = new CoALALocalFileStorageAdapter(tempDir);

  // First, create some data to compact
  await adapter.commitByType("working", {
    keep1: { relevanceScore: 0.8 },
    remove1: { relevanceScore: 0.05 },
    keep2: { relevanceScore: 0.9 },
  });

  await adapter.commitByType("episodic", {
    keep3: { relevanceScore: 0.7 },
    remove2: { relevanceScore: 0.02 },
  });

  // Track concurrent writes only (reads can be concurrent)
  let concurrentWrites = 0;
  let maxConcurrent = 0;

  const originalWriteTextFile = Deno.writeTextFile;

  Deno.writeTextFile = async (path, data, options) => {
    concurrentWrites++;
    maxConcurrent = Math.max(maxConcurrent, concurrentWrites);

    await new Promise((resolve) => setTimeout(resolve, 5));
    const result = await originalWriteTextFile(path, data, options);

    concurrentWrites--;
    return result;
  };

  try {
    // Compact all memory types
    await adapter.compactAllMemoryTypes();

    // Verify sequential execution of writes
    assertEquals(maxConcurrent, 1, "Memory compaction writes should be sequential, not concurrent");
  } finally {
    // Restore original function
    Deno.writeTextFile = originalWriteTextFile;
    await cleanupTempDir(tempDir);
  }
});
