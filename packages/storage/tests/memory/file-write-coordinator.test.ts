import { assertEquals, assertExists } from "@std/assert";
import { FileWriteCoordinator } from "../../src/memory/file-write-coordinator.ts";

// Set test env
Deno.env.set("DENO_TESTING", "true");

Deno.test("FileWriteCoordinator - should prevent concurrent writes to same file", async () => {
  const coordinator = FileWriteCoordinator.getInstance();
  const testFile = await Deno.makeTempFile();

  let writeCount = 0;
  let concurrentWrites = 0;
  let maxConcurrent = 0;

  // Create multiple write operations
  const writes = Array.from(
    { length: 10 },
    (_, i) =>
      coordinator.executeWrite(testFile, async () => {
        concurrentWrites++;
        maxConcurrent = Math.max(maxConcurrent, concurrentWrites);

        // Simulate write delay
        await new Promise((resolve) => setTimeout(resolve, 10));

        await Deno.writeTextFile(testFile, `Write ${i}\n`, { append: true });
        writeCount++;

        concurrentWrites--;
      }),
  );

  // Execute all writes concurrently
  await Promise.all(writes);

  // Verify all writes completed
  assertEquals(writeCount, 10);

  // Verify no concurrent writes happened (max concurrent should be 1)
  assertEquals(maxConcurrent, 1, "Multiple writes should not happen concurrently");

  // Verify file contents
  const content = await Deno.readTextFile(testFile);
  const lines = content.trim().split("\n");
  assertEquals(lines.length, 10);

  // Clean up
  await Deno.remove(testFile);
});

Deno.test("FileWriteCoordinator - should handle writes to different files concurrently", async () => {
  const coordinator = FileWriteCoordinator.getInstance();
  const testFile1 = await Deno.makeTempFile();
  const testFile2 = await Deno.makeTempFile();

  let file1Writes = 0;
  let file2Writes = 0;
  let maxConcurrent = 0;
  let currentConcurrent = 0;

  // Create writes to different files
  const writes = [
    ...Array.from({ length: 5 }, (_, i) =>
      coordinator.executeWrite(testFile1, async () => {
        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        await new Promise((resolve) => setTimeout(resolve, 10));
        await Deno.writeTextFile(testFile1, `File1 Write ${i}\n`, { append: true });
        file1Writes++;
        currentConcurrent--;
      })),
    ...Array.from({ length: 5 }, (_, i) =>
      coordinator.executeWrite(testFile2, async () => {
        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        await new Promise((resolve) => setTimeout(resolve, 10));
        await Deno.writeTextFile(testFile2, `File2 Write ${i}\n`, { append: true });
        file2Writes++;
        currentConcurrent--;
      })),
  ];

  // Execute all writes
  await Promise.all(writes);

  // Verify all writes completed
  assertEquals(file1Writes, 5);
  assertEquals(file2Writes, 5);

  // Different files can be written concurrently, so max concurrent should be > 1
  assertEquals(maxConcurrent > 1, true, "Different files should allow concurrent writes");

  // Clean up
  await Deno.remove(testFile1);
  await Deno.remove(testFile2);
});

Deno.test("FileWriteCoordinator - should maintain singleton instance", () => {
  const coordinator1 = FileWriteCoordinator.getInstance();
  const coordinator2 = FileWriteCoordinator.getInstance();

  assertExists(coordinator1);
  assertExists(coordinator2);
  assertEquals(coordinator1, coordinator2, "Should return same instance");
});
