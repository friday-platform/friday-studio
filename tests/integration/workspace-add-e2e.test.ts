/**
 * End-to-end integration tests for workspace add functionality
 * Tests the complete flow including file system operations and daemon interaction
 */

import { AtlasDaemon } from "@atlas/atlasd";
import { AtlasClient } from "@atlas/client";
import { assertEquals, assertExists } from "@std/assert";
import { ensureDir, exists } from "@std/fs";
import { join } from "@std/path";
import { getWorkspaceManager, resetWorkspaceManager } from "../../src/core/workspace-manager.ts";

// Helper to create a test workspace directory with workspace.yml
async function createTestWorkspace(basePath: string, name: string): Promise<string> {
  const workspacePath = join(basePath, name);
  await ensureDir(workspacePath);

  // Create a minimal workspace.yml
  const workspaceYml = `
workspace:
  name: ${name}
  description: Test workspace for integration tests
  version: 1.0.0

signals:
  test-signal:
    provider: cli
    name: test-signal
    description: Test signal

jobs:
  test-job:
    name: test-job
    description: Test job
    steps:
      - tool: echo
        arguments:
          message: "Hello from test job"
`;

  await Deno.writeTextFile(join(workspacePath, "workspace.yml"), workspaceYml);
  return workspacePath;
}

// Helper to clean up test directories
async function cleanupTestDirectory(path: string) {
  try {
    if (await exists(path)) {
      await Deno.remove(path, { recursive: true });
    }
  } catch {
    // Ignore cleanup errors
  }
}

// Helper to reset state between tests
async function resetTestState() {
  resetWorkspaceManager();
  // Clear any persisted data
  const testKvPath = join(Deno.env.get("HOME") || "", ".atlas", "test.db");
  try {
    await Deno.remove(testKvPath);
  } catch {
    // Ignore if doesn't exist
  }
}

// Initialize clean state before each test
await resetTestState();

Deno.test({
  name: "Workspace Add E2E - Complete single workspace flow",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const testDir = await Deno.makeTempDir({ prefix: "atlas-test-" });
    const port = 10000 + Math.floor(Math.random() * 10000);
    const daemon = new AtlasDaemon({ port });

    try {
      // Start daemon
      await daemon.initialize();
      await daemon.startNonBlocking();

      // Create test workspace
      const workspacePath = await createTestWorkspace(testDir, "e2e-test-workspace");

      // Add workspace via client
      const client = new AtlasClient({ url: `http://localhost:${port}` });

      // Use a unique name for this test run
      const uniqueName = `E2E Test Workspace ${Date.now()}`;
      const result = await client.addWorkspace({
        path: workspacePath,
        name: uniqueName,
        description: "Test workspace for E2E testing",
      });

      // Verify result
      assertExists(result.id);
      assertEquals(result.name, uniqueName);
      // Handle macOS symlink path resolution
      assertEquals(result.path.replace(/^\/private/, ""), workspacePath.replace(/^\/private/, ""));
      assertEquals(result.status, "stopped");

      // Try to add again - should fail with 409
      let failed = false;
      try {
        await client.addWorkspace({
          path: workspacePath,
        });
      } catch (error) {
        failed = true;
        assertEquals(error.status, 409);
      }
      assertEquals(failed, true, "Should have failed with 409 for duplicate path");

      // Clean up the workspace
      await client.deleteWorkspace(result.id);
    } finally {
      await daemon.shutdown();
      await cleanupTestDirectory(testDir);
    }
  },
});

Deno.test({
  name: "Workspace Add E2E - Batch registration with scanning",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    // Set test mode to avoid persisting data
    Deno.env.set("DENO_TEST", "true");
    await resetTestState();
    const testDir = await Deno.makeTempDir({ prefix: "atlas-batch-test-" });
    const port = 10000 + Math.floor(Math.random() * 10000);
    const daemon = new AtlasDaemon({ port });

    try {
      // Start daemon
      await daemon.initialize();
      await daemon.startNonBlocking();

      // Create multiple test workspaces
      const workspace1 = await createTestWorkspace(testDir, "batch-workspace-1");
      const workspace2 = await createTestWorkspace(testDir, "batch-workspace-2");
      const workspace3 = await createTestWorkspace(testDir, "batch-workspace-3");

      // Create a nested workspace
      const nestedDir = join(testDir, "nested");
      await ensureDir(nestedDir);
      const workspace4 = await createTestWorkspace(nestedDir, "nested-workspace");

      // Batch add all workspaces
      const client = new AtlasClient({ url: `http://localhost:${port}` });
      const result = await client.addWorkspaces({
        paths: [workspace1, workspace2, workspace3, workspace4],
      });

      // Verify all were added
      assertEquals(result.added.length, 4);
      assertEquals(result.failed.length, 0);

      // Verify each workspace
      const manager = await getWorkspaceManager();
      for (const added of result.added) {
        const workspace = await manager.findById(added.id);
        assertExists(workspace);
        assertEquals(workspace.path, added.path);
      }

      // Try to add some again - should get partial failures
      const result2 = await client.addWorkspaces({
        paths: [workspace1, workspace2, join(testDir, "nonexistent")],
      });

      assertEquals(result2.added.length, 0);
      assertEquals(result2.failed.length, 3); // workspace1, workspace2, and nonexistent

      // Find the failed workspaces in the results
      const failedPaths = result2.failed.map((f) => f.path);
      assertEquals(failedPaths.includes(workspace1), true);
      assertEquals(failedPaths.includes(workspace2), true);
      assertEquals(failedPaths.some((p) => p.includes("nonexistent")), true);

      // Clean up all added workspaces
      for (const added of result.added) {
        await client.deleteWorkspace(added.id);
      }
    } finally {
      await daemon.shutdown();
      await cleanupTestDirectory(testDir);
      await resetTestState();
    }
  },
});

Deno.test({
  name: "Workspace Add E2E - Path validation",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    // Set test mode to avoid persisting data
    Deno.env.set("DENO_TEST", "true");
    await resetTestState();
    const testDir = await Deno.makeTempDir({ prefix: "atlas-validation-test-" });
    const port = 10000 + Math.floor(Math.random() * 10000);
    const daemon = new AtlasDaemon({ port });

    try {
      // Start daemon
      await daemon.initialize();
      await daemon.startNonBlocking();

      const client = new AtlasClient({ url: `http://localhost:${port}` });

      // Test 1: Non-existent path
      let error = null;
      try {
        await client.addWorkspace({
          path: "/this/path/does/not/exist",
        });
      } catch (e) {
        error = e;
      }
      assertExists(error);
      assertEquals(error.status, 404);

      // Test 2: Path is a file, not directory
      const filePath = join(testDir, "not-a-directory.txt");
      await Deno.writeTextFile(filePath, "test");

      error = null;
      try {
        await client.addWorkspace({
          path: filePath,
        });
      } catch (e) {
        error = e;
      }
      assertExists(error);
      assertEquals(error.status, 400);

      // Test 3: Directory without workspace.yml
      const noYmlDir = join(testDir, "no-yml");
      await ensureDir(noYmlDir);

      error = null;
      try {
        await client.addWorkspace({
          path: noYmlDir,
        });
      } catch (e) {
        error = e;
      }
      assertExists(error);
      assertEquals(error.status, 400);
      assertEquals(error.message.includes("workspace.yml not found"), true);
    } finally {
      await daemon.shutdown();
      await cleanupTestDirectory(testDir);
      await resetTestState();
    }
  },
});

Deno.test({
  name: "Workspace Add E2E - Name conflict handling",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    // Set test mode to avoid persisting data
    Deno.env.set("DENO_TEST", "true");
    await resetTestState();
    const testDir = await Deno.makeTempDir({ prefix: "atlas-name-test-" });
    const port = 10000 + Math.floor(Math.random() * 10000);
    const daemon = new AtlasDaemon({ port });

    try {
      // Start daemon
      await daemon.initialize();
      await daemon.startNonBlocking();

      // Create two different workspace directories
      const workspace1 = await createTestWorkspace(testDir, "workspace-a");
      const workspace2 = await createTestWorkspace(testDir, "workspace-b");

      const client = new AtlasClient({ url: `http://localhost:${port}` });

      // Use a unique name for this test run
      const uniqueSharedName = `Shared Name ${Date.now()}`;

      // Add first workspace with custom name
      const result1 = await client.addWorkspace({
        path: workspace1,
        name: uniqueSharedName,
      });

      assertEquals(result1.name, uniqueSharedName);

      // Try to add second workspace with same name - should fail
      let error = null;
      try {
        await client.addWorkspace({
          path: workspace2,
          name: uniqueSharedName,
        });
      } catch (e) {
        error = e;
      }

      assertExists(error);
      assertEquals(error.status, 409);
      assertEquals(
        error.message.includes(`Workspace with name '${uniqueSharedName}' already exists`),
        true,
      );

      // But adding without custom name should work
      const result2 = await client.addWorkspace({
        path: workspace2,
      });

      assertEquals(result2.name, "workspace-b"); // Default name from directory
      assertExists(result2.id);

      // Clean up both workspaces
      await client.deleteWorkspace(result1.id);
      await client.deleteWorkspace(result2.id);
    } finally {
      await daemon.shutdown();
      await cleanupTestDirectory(testDir);
      await resetTestState();
    }
  },
});

Deno.test({
  name: "Workspace Add E2E - Concurrent batch processing",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    // Set test mode to avoid persisting data
    Deno.env.set("DENO_TEST", "true");
    await resetTestState();
    const testDir = await Deno.makeTempDir({ prefix: "atlas-concurrent-test-" });
    const port = 10000 + Math.floor(Math.random() * 10000);
    const daemon = new AtlasDaemon({ port });

    try {
      // Start daemon
      await daemon.initialize();
      await daemon.startNonBlocking();

      // Create many workspaces to test concurrency
      const workspacePaths: string[] = [];
      for (let i = 1; i <= 10; i++) {
        const path = await createTestWorkspace(testDir, `concurrent-workspace-${i}`);
        workspacePaths.push(path);
      }

      const client = new AtlasClient({ url: `http://localhost:${port}` });

      // Measure time for batch operation
      const start = Date.now();
      const result = await client.addWorkspaces({
        paths: workspacePaths,
      });
      const duration = Date.now() - start;

      // All should succeed
      assertEquals(result.added.length, 10);
      assertEquals(result.failed.length, 0);

      // Verify they were processed concurrently (should be reasonably fast)
      // With concurrency of 5, 10 workspaces should complete quickly
      assertEquals(duration < 5000, true, `Batch operation took ${duration}ms, expected < 5000ms`);

      // Verify all workspaces were processed successfully
      // We already checked that result.added.length is 10
      // Don't check the workspace manager's total count as it may have data from other tests

      // Clean up all added workspaces
      for (const added of result.added) {
        await client.deleteWorkspace(added.id);
      }
    } finally {
      await daemon.shutdown();
      await cleanupTestDirectory(testDir);
      await resetTestState();
    }
  },
});
