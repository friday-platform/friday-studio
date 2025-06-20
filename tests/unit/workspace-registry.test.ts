#!/usr/bin/env -S deno test --allow-env --allow-read --allow-write --allow-run

/**
 * Unit tests for workspace registry functionality
 * Tests registry operations, validation, and lazy health checks
 */

import { expect } from "@std/expect";
import { join } from "@std/path";
import { ensureDir, exists } from "@std/fs";
import { z } from "zod";
import { WorkspaceRegistryManager } from "../../src/core/workspace-registry.ts";
import { WorkspaceEntrySchema, WorkspaceStatus } from "../../src/core/workspace-registry-types.ts";
import {
  generateUniqueWorkspaceName,
  generateWorkspaceName,
} from "../../src/core/workspace-names.ts";

// Helper to create isolated test environment
async function createTestEnvironment() {
  const testDir = await Deno.makeTempDir({ prefix: "atlas-registry-test-" });

  // Create a new registry manager with isolated HOME
  const originalHome = Deno.env.get("HOME");
  Deno.env.set("HOME", testDir);

  const cleanup = async () => {
    if (originalHome) {
      Deno.env.set("HOME", originalHome);
    } else {
      Deno.env.delete("HOME");
    }
    try {
      await Deno.remove(testDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  };

  return {
    testDir,
    registry: new WorkspaceRegistryManager(),
    cleanup,
  };
}

Deno.test("workspace names - generates docker-style names", () => {
  const name = generateWorkspaceName();
  expect(name).toMatch(/^[a-z]+_[a-z]+$/);

  // Should have two parts separated by underscore
  const parts = name.split("_");
  expect(parts.length).toBe(2);

  // Both parts should be non-empty
  expect(parts[0].length).toBeGreaterThan(0);
  expect(parts[1].length).toBeGreaterThan(0);
});

Deno.test("workspace names - ensures uniqueness", () => {
  const existingNames = new Set([
    "happy_einstein",
    "fervent_turing",
    "brave_hopper",
  ]);

  const newName = generateUniqueWorkspaceName(existingNames);
  expect(existingNames.has(newName)).toBe(false);
});

Deno.test("workspace registry - initializes with empty registry", async () => {
  const { registry, testDir, cleanup } = await createTestEnvironment();

  try {
    await registry.initialize();

    const all = await registry.listAll();
    expect(all).toEqual([]);

    // Registry file should exist
    const registryPath = join(testDir, ".atlas", "registry.json");
    expect(await exists(registryPath)).toBe(true);
  } finally {
    await cleanup();
  }
});

Deno.test("workspace registry - registers new workspace", async () => {
  const { registry, testDir, cleanup } = await createTestEnvironment();

  try {
    await registry.initialize();

    const workspacePath = join(testDir, "test-workspace");
    await ensureDir(workspacePath);

    const entry = await registry.register(workspacePath, {
      name: "Test Workspace",
      description: "A test workspace",
      tags: ["test", "demo"],
    });

    expect(entry.name).toBe("Test Workspace");
    // Handle macOS /var -> /private/var symlink
    expect(entry.path).toBe(await Deno.realPath(workspacePath));
    expect(entry.status).toBe(WorkspaceStatus.STOPPED);
    expect(entry.metadata?.description).toBe("A test workspace");
    expect(entry.metadata?.tags).toEqual(["test", "demo"]);

    // ID should be docker-style
    expect(entry.id).toMatch(/^[a-z]+_[a-z]+(_\d+)?$/);
  } finally {
    await cleanup();
  }
});

Deno.test("workspace registry - validates entries with Zod", async () => {
  // Create an invalid entry manually
  const invalidEntry = {
    id: "test",
    name: "Test",
    path: "/test",
    configPath: "/test/workspace.yml",
    status: "invalid-status", // Invalid status
    createdAt: "not-a-date", // Invalid date
    lastSeen: "not-a-date",
  };

  // Should throw validation error
  expect(() => WorkspaceEntrySchema.parse(invalidEntry)).toThrow(z.ZodError);
});

Deno.test("workspace registry - finds workspace by ID", async () => {
  const { registry, testDir, cleanup } = await createTestEnvironment();

  try {
    await registry.initialize();

    const workspacePath = join(testDir, "find-by-id");
    await ensureDir(workspacePath);

    const entry = await registry.register(workspacePath, {
      name: "Find By ID Test",
    });

    const found = await registry.findById(entry.id);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(entry.id);
    expect(found?.name).toBe("Find By ID Test");
  } finally {
    await cleanup();
  }
});

Deno.test("workspace registry - finds workspace by name", async () => {
  const { registry, testDir, cleanup } = await createTestEnvironment();

  try {
    await registry.initialize();

    const workspacePath = join(testDir, "find-by-name");
    await ensureDir(workspacePath);

    await registry.register(workspacePath, {
      name: "Unique Test Name",
    });

    const found = await registry.findByName("Unique Test Name");
    expect(found).not.toBeNull();
    expect(found?.name).toBe("Unique Test Name");
  } finally {
    await cleanup();
  }
});

Deno.test("workspace registry - finds workspace by path", async () => {
  const { registry, testDir, cleanup } = await createTestEnvironment();

  try {
    await registry.initialize();

    const workspacePath = join(testDir, "find-by-path");
    await ensureDir(workspacePath);

    const entry = await registry.register(workspacePath);

    const found = await registry.findByPath(workspacePath);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(entry.id);
  } finally {
    await cleanup();
  }
});

Deno.test("workspace registry - prevents duplicate registration", async () => {
  const { registry, testDir, cleanup } = await createTestEnvironment();

  try {
    await registry.initialize();

    const workspacePath = join(testDir, "duplicate-test");
    await ensureDir(workspacePath);

    const first = await registry.register(workspacePath, {
      name: "First Registration",
    });

    const second = await registry.register(workspacePath, {
      name: "Second Registration", // Different name
    });

    // Should return the existing entry, not create a new one
    expect(second.id).toBe(first.id);
    expect(second.name).toBe("First Registration"); // Original name preserved
  } finally {
    await cleanup();
  }
});

Deno.test("workspace registry - updates workspace status", async () => {
  const { registry, testDir, cleanup } = await createTestEnvironment();

  try {
    await registry.initialize();

    const workspacePath = join(testDir, "status-update");
    await ensureDir(workspacePath);

    const entry = await registry.register(workspacePath);
    expect(entry.status).toBe(WorkspaceStatus.STOPPED);

    // Update to running with current process PID (so health check passes)
    await registry.updateStatus(entry.id, WorkspaceStatus.RUNNING, {
      pid: Deno.pid, // Use current process so it's valid
      port: 8080,
    });

    const updated = await registry.findById(entry.id);
    expect(updated?.status).toBe(WorkspaceStatus.RUNNING);
    expect(updated?.pid).toBe(Deno.pid);
    expect(updated?.port).toBe(8080);
    expect(updated?.startedAt).toBeDefined();
  } finally {
    await cleanup();
  }
});

Deno.test("workspace registry - lazy health check detects crashed process", async () => {
  const { registry, testDir, cleanup } = await createTestEnvironment();

  try {
    await registry.initialize();

    const workspacePath = join(testDir, "health-check");
    await ensureDir(workspacePath);

    const entry = await registry.register(workspacePath);

    // Simulate a running process with invalid PID
    await registry.updateStatus(entry.id, WorkspaceStatus.RUNNING, {
      pid: 999999, // Non-existent PID
      port: 8080,
    });

    // When we query it, health check should detect it's crashed
    const checked = await registry.findById(entry.id);
    expect(checked?.status).toBe(WorkspaceStatus.CRASHED);
    expect(checked?.pid).toBeUndefined();
    expect(checked?.port).toBeUndefined();
    expect(checked?.stoppedAt).toBeDefined();
  } finally {
    await cleanup();
  }
});

Deno.test("workspace registry - lists all workspaces", async () => {
  const { registry, testDir, cleanup } = await createTestEnvironment();

  try {
    await registry.initialize();

    // Register multiple workspaces
    const paths = ["ws1", "ws2", "ws3"].map((name) => join(testDir, name));
    for (const path of paths) {
      await ensureDir(path);
      await registry.register(path);
    }

    const all = await registry.listAll();
    expect(all.length).toBe(3);
  } finally {
    await cleanup();
  }
});

Deno.test("workspace registry - lists only running workspaces", async () => {
  const { registry, testDir, cleanup } = await createTestEnvironment();

  try {
    await registry.initialize();

    // Register workspaces with different statuses
    const runningPath = join(testDir, "running-ws");
    const stoppedPath = join(testDir, "stopped-ws");

    await ensureDir(runningPath);
    await ensureDir(stoppedPath);

    const running = await registry.register(runningPath);
    await registry.register(stoppedPath);

    // Update one to running
    await registry.updateStatus(running.id, WorkspaceStatus.RUNNING, {
      pid: Deno.pid, // Use current process PID so it's valid
      port: 8080,
    });

    const runningWorkspaces = await registry.getRunning();
    expect(runningWorkspaces.length).toBe(1);
    expect(runningWorkspaces[0].id).toBe(running.id);
  } finally {
    await cleanup();
  }
});

Deno.test("workspace registry - unregisters workspace", async () => {
  const { registry, testDir, cleanup } = await createTestEnvironment();

  try {
    await registry.initialize();

    const workspacePath = join(testDir, "unregister-test");
    await ensureDir(workspacePath);

    const entry = await registry.register(workspacePath);

    // Verify it exists
    const exists = await registry.findById(entry.id);
    expect(exists).not.toBeNull();

    // Unregister
    await registry.unregister(entry.id);

    // Verify it's gone
    const gone = await registry.findById(entry.id);
    expect(gone).toBeNull();
  } finally {
    await cleanup();
  }
});

Deno.test("workspace registry - cleans up non-existent workspaces", async () => {
  const { registry, testDir, cleanup } = await createTestEnvironment();

  try {
    await registry.initialize();

    // Register a workspace
    const workspacePath = join(testDir, "cleanup-test");
    await ensureDir(workspacePath);
    const entry = await registry.register(workspacePath);

    // Delete the directory
    await Deno.remove(workspacePath, { recursive: true });

    // Run cleanup
    const cleaned = await registry.cleanup();
    expect(cleaned).toBe(1);

    // Workspace should be gone
    const gone = await registry.findById(entry.id);
    expect(gone).toBeNull();
  } finally {
    await cleanup();
  }
});

Deno.test("workspace registry - findOrRegister returns existing", async () => {
  const { registry, testDir, cleanup } = await createTestEnvironment();

  try {
    await registry.initialize();

    const workspacePath = join(testDir, "find-or-register");
    await ensureDir(workspacePath);

    // First call registers
    const first = await registry.findOrRegister(workspacePath, {
      name: "First Call",
    });

    // Second call finds existing
    const second = await registry.findOrRegister(workspacePath, {
      name: "Second Call", // Different name
    });

    expect(second.id).toBe(first.id);
    expect(second.name).toBe("First Call"); // Original name preserved
  } finally {
    await cleanup();
  }
});

Deno.test("workspace registry - getCurrentWorkspace finds cwd", async () => {
  const { registry, testDir, cleanup } = await createTestEnvironment();

  try {
    await registry.initialize();

    // Register current directory
    const originalCwd = Deno.cwd();
    const testWorkspace = join(testDir, "current-ws");
    await ensureDir(testWorkspace);

    // Change to test directory
    Deno.chdir(testWorkspace);

    try {
      await registry.register(testWorkspace, {
        name: "Current Workspace",
      });

      const current = await registry.getCurrentWorkspace();
      expect(current).not.toBeNull();
      expect(current?.name).toBe("Current Workspace");
    } finally {
      // Restore original cwd
      Deno.chdir(originalCwd);
    }
  } finally {
    await cleanup();
  }
});
