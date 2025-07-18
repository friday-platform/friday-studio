// Set testing mode to disable file logging
Deno.env.set("DENO_TESTING", "true");

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { LocalFileStorageAdapter } from "../../src/memory/local.ts";

// Helper function to create temporary directory for tests
async function createTempDir(): Promise<string> {
  const tempDir = await Deno.makeTempDir({ prefix: "atlas_local_storage_test_" });
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

Deno.test("LocalFileStorageAdapter - should store and retrieve data", async () => {
  const tempDir = await createTempDir();
  const adapter = new LocalFileStorageAdapter(tempDir);

  try {
    const testData = {
      key1: "value1",
      key2: { nested: "value2" },
      key3: [1, 2, 3],
    };

    await adapter.commit(testData);
    const loaded = await adapter.load();

    assertEquals(loaded.key1, "value1");
    assertEquals(loaded.key2.nested, "value2");
    assertEquals(loaded.key3.length, 3);
  } finally {
    await cleanupTempDir(tempDir);
  }
});

Deno.test("LocalFileStorageAdapter - should return null for non-existent file", async () => {
  const tempDir = await createTempDir();
  const adapter = new LocalFileStorageAdapter(tempDir);

  try {
    const loaded = await adapter.load();
    assertEquals(loaded, null);
  } finally {
    await cleanupTempDir(tempDir);
  }
});

Deno.test("LocalFileStorageAdapter - should create directory if it doesn't exist", async () => {
  const nonExistentDir = "/tmp/non-existent-dir-" + Date.now();
  const adapter = new LocalFileStorageAdapter(nonExistentDir);

  try {
    const testData = { test: "data" };
    await adapter.commit(testData);

    // Check that directory was created
    const dirExists = await Deno.stat(nonExistentDir).then(() => true).catch(() => false);
    assertEquals(dirExists, true);

    // Check that file was created
    const fileExists = await Deno.stat(join(nonExistentDir, "memory.json")).then(() => true).catch(
      () => false,
    );
    assertEquals(fileExists, true);

    // Check that data can be loaded
    const loaded = await adapter.load();
    assertEquals(loaded.test, "data");
  } finally {
    await cleanupTempDir(nonExistentDir);
  }
});

Deno.test("LocalFileStorageAdapter - should handle empty data", async () => {
  const tempDir = await createTempDir();
  const adapter = new LocalFileStorageAdapter(tempDir);

  try {
    const emptyData = {};
    await adapter.commit(emptyData);
    const loaded = await adapter.load();

    assertEquals(typeof loaded, "object");
    assertEquals(Object.keys(loaded).length, 0);
  } finally {
    await cleanupTempDir(tempDir);
  }
});

Deno.test("LocalFileStorageAdapter - should handle null data", async () => {
  const tempDir = await createTempDir();
  const adapter = new LocalFileStorageAdapter(tempDir);

  try {
    await adapter.commit(null);
    const loaded = await adapter.load();

    assertEquals(loaded, null);
  } finally {
    await cleanupTempDir(tempDir);
  }
});

Deno.test("LocalFileStorageAdapter - should overwrite existing data", async () => {
  const tempDir = await createTempDir();
  const adapter = new LocalFileStorageAdapter(tempDir);

  try {
    // Store initial data
    await adapter.commit({ initial: "data" });
    let loaded = await adapter.load();
    assertEquals(loaded.initial, "data");

    // Store new data (should overwrite)
    await adapter.commit({ new: "data", additional: "field" });
    loaded = await adapter.load();
    assertEquals(loaded.new, "data");
    assertEquals(loaded.additional, "field");
    assertEquals(loaded.initial, undefined);
  } finally {
    await cleanupTempDir(tempDir);
  }
});

Deno.test("LocalFileStorageAdapter - should handle complex nested data", async () => {
  const tempDir = await createTempDir();
  const adapter = new LocalFileStorageAdapter(tempDir);

  try {
    const complexData = {
      user: {
        name: "John Doe",
        preferences: {
          theme: "dark",
          notifications: {
            email: true,
            push: false,
          },
        },
      },
      sessions: [
        { id: 1, timestamp: new Date().toISOString(), data: { key: "value" } },
        { id: 2, timestamp: new Date().toISOString(), data: { key: "value2" } },
      ],
      metadata: {
        version: "1.0.0",
        lastModified: new Date().toISOString(),
      },
    };

    await adapter.commit(complexData);
    const loaded = await adapter.load();

    assertEquals(loaded.user.name, "John Doe");
    assertEquals(loaded.user.preferences.theme, "dark");
    assertEquals(loaded.user.preferences.notifications.email, true);
    assertEquals(loaded.sessions.length, 2);
    assertEquals(loaded.sessions[0].id, 1);
    assertEquals(loaded.metadata.version, "1.0.0");
  } finally {
    await cleanupTempDir(tempDir);
  }
});

Deno.test("LocalFileStorageAdapter - should use default storage path", async () => {
  const adapter = new LocalFileStorageAdapter();

  try {
    const testData = { test: "default path" };
    await adapter.commit(testData);
    const loaded = await adapter.load();

    assertEquals(loaded.test, "default path");

    // Cleanup default path
    const defaultPath = join(Deno.cwd(), ".atlas", "memory");
    await cleanupTempDir(defaultPath);
  } catch (error) {
    // Cleanup default path even if test fails
    const defaultPath = join(Deno.cwd(), ".atlas", "memory");
    await cleanupTempDir(defaultPath);
    throw error;
  }
});
