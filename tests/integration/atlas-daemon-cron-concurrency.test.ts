/**
 * AtlasDaemon Cron Integration Concurrency Tests
 *
 * These tests expose race conditions in the AtlasDaemon's integration with
 * the cron system, particularly around workspace discovery, registration,
 * and lifecycle management.
 */

import { assert, assertEquals, assertExists } from "@std/assert";
import { AtlasDaemon } from "../../apps/atlasd/src/atlas-daemon.ts";
import { getWorkspaceManager } from "../../src/core/workspace-manager.ts";
import { FilesystemConfigAdapter } from "@atlas/storage";
import { ConfigLoader } from "@atlas/config";
import {
  assertTimeBounds,
  delay,
  RaceConditionDetector,
  runConcurrent,
  stressTest,
} from "../../packages/cron/tests/concurrency-test-utils.ts";
import { join } from "@std/path";

// Test workspace configurations with cron signals
const createTestWorkspaceConfig = (workspaceId: string) => ({
  workspace: {
    name: `Test Workspace ${workspaceId}`,
    description: "Test workspace for cron concurrency testing",
    signals: {
      [`timer-${workspaceId}-1`]: {
        provider: "cron-scheduler",
        schedule: "*/30 * * * *", // Every 30 minutes
        timezone: "UTC",
        description: `Timer signal 1 for ${workspaceId}`,
      },
      [`timer-${workspaceId}-2`]: {
        provider: "cron-scheduler",
        schedule: "0 9 * * 1", // Monday 9 AM
        timezone: "America/Los_Angeles",
        description: `Timer signal 2 for ${workspaceId}`,
      },
    },
    jobs: {},
    agents: {},
  },
});

async function createTestDaemon(port = 8080) {
  const daemon = new AtlasDaemon({ port });
  await daemon.initialize();
  return daemon;
}

async function createTempWorkspace(workspaceId: string, baseDir: string) {
  const workspacePath = join(baseDir, workspaceId);
  await Deno.mkdir(workspacePath, { recursive: true });

  const config = createTestWorkspaceConfig(workspaceId);
  const configPath = join(workspacePath, "workspace.yml");

  await Deno.writeTextFile(
    configPath,
    `# Workspace configuration
workspace:
  name: "${config.workspace.name}"
  description: "${config.workspace.description}"

signals:
  timer-${workspaceId}-1:
    provider: "cron-scheduler"
    schedule: "*/30 * * * *"
    timezone: "UTC"
    description: "Timer signal 1 for ${workspaceId}"
  timer-${workspaceId}-2:
    provider: "cron-scheduler"
    schedule: "0 9 * * 1"
    timezone: "America/Los_Angeles"
    description: "Timer signal 2 for ${workspaceId}"

jobs: {}
agents: {}
`,
  );

  return { workspacePath, configPath };
}

async function cleanupTempDir(path: string) {
  try {
    await Deno.remove(path, { recursive: true });
  } catch {
    // Ignore cleanup errors
  }
}

Deno.test("AtlasDaemon Cron Concurrency - workspace discovery concurrency should not create duplicates", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "atlas-cron-test-" });
  const daemon = await createTestDaemon(8081);

  try {
    // Create multiple test workspaces
    const workspaceIds = Array(10).fill(null).map((_, i) => `workspace-${i}`);

    for (const workspaceId of workspaceIds) {
      await createTempWorkspace(workspaceId, tempDir);
    }

    // Add workspaces to the workspace manager
    const manager = getWorkspaceManager();
    for (const workspaceId of workspaceIds) {
      const workspacePath = join(tempDir, workspaceId);
      await manager.addWorkspace({
        id: workspaceId,
        name: `Test Workspace ${workspaceId}`,
        path: workspacePath,
        description: `Test workspace ${workspaceId}`,
      });
    }

    // Simulate concurrent workspace discovery (like daemon startup)
    const discoveryPromises = workspaceIds.map((workspaceId) =>
      (daemon as any).registerWorkspaceCronSignals(workspaceId, join(tempDir, workspaceId))
    );

    await runConcurrent(discoveryPromises);

    // Check that timers were registered correctly without duplicates
    const cronManager = daemon.getCronManager();
    assertExists(cronManager, "CronManager should be available");

    const activeTimers = cronManager.listActiveTimers();

    // Should have exactly 2 timers per workspace (20 total)
    assertEquals(activeTimers.length, 20, "Should have exactly 2 timers per workspace");

    // Check for duplicates
    const timerKeys = activeTimers.map((t) => `${t.workspaceId}:${t.signalId}`);
    const uniqueKeys = new Set(timerKeys);
    assertEquals(uniqueKeys.size, timerKeys.length, "Should not have duplicate timer keys");

    // Verify all workspaces are represented
    const workspacesCovered = new Set(activeTimers.map((t) => t.workspaceId));
    assertEquals(workspacesCovered.size, 10, "All workspaces should have registered timers");
  } finally {
    await daemon.shutdown();
    await cleanupTempDir(tempDir);
  }
});

Deno.test("AtlasDaemon Cron Concurrency - daemon shutdown during cron operations should be safe", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "atlas-cron-shutdown-" });
  const daemon = await createTestDaemon(8082);

  try {
    // Create a workspace with cron signals
    const { workspacePath } = await createTempWorkspace("shutdown-test", tempDir);

    const manager = getWorkspaceManager();
    await manager.addWorkspace({
      id: "shutdown-test",
      name: "Shutdown Test Workspace",
      path: workspacePath,
      description: "Test workspace for shutdown timing",
    });

    // Register cron signals
    await (daemon as any).registerWorkspaceCronSignals("shutdown-test", workspacePath);

    // Start some cron operations
    const cronManager = daemon.getCronManager();
    assertExists(cronManager, "CronManager should be available");

    // Verify timers are registered
    const activeTimers = cronManager.listActiveTimers();
    assert(activeTimers.length > 0, "Should have active timers");

    // Start shutdown while cron operations might be running
    const shutdownStart = performance.now();
    const shutdownPromise = daemon.shutdown();

    // Shutdown should complete within reasonable time
    await assertTimeBounds(
      () => shutdownPromise,
      0,
      10000, // 10 seconds max
      "Daemon shutdown with active cron operations",
    );

    const shutdownTime = performance.now() - shutdownStart;
    console.log(`Shutdown completed in ${shutdownTime}ms`);

    // After shutdown, cron manager should be null
    const finalCronManager = daemon.getCronManager();
    assertEquals(finalCronManager, null, "CronManager should be null after shutdown");
  } finally {
    // Ensure cleanup even if test fails
    try {
      await daemon.shutdown();
    } catch {
      // Ignore if already shut down
    }
    await cleanupTempDir(tempDir);
  }
});

Deno.test("AtlasDaemon Cron Concurrency - workspace deletion during timer execution should cleanup properly", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "atlas-cron-delete-" });
  const daemon = await createTestDaemon(8083);

  try {
    // Create test workspace
    const { workspacePath } = await createTempWorkspace("delete-test", tempDir);

    const manager = getWorkspaceManager();
    await manager.addWorkspace({
      id: "delete-test",
      name: "Delete Test Workspace",
      path: workspacePath,
      description: "Test workspace for deletion timing",
    });

    // Register cron signals
    await (daemon as any).registerWorkspaceCronSignals("delete-test", workspacePath);

    const cronManager = daemon.getCronManager();
    assertExists(cronManager, "CronManager should be available");

    // Verify timers are registered
    let activeTimers = cronManager.listActiveTimers();
    const initialTimerCount = activeTimers.length;
    assert(initialTimerCount > 0, "Should have active timers before deletion");

    // Delete workspace (which should unregister cron signals)
    await (daemon as any).unregisterWorkspaceCronSignals("delete-test");

    // Verify timers are unregistered
    activeTimers = cronManager.listActiveTimers();
    const remainingTimers = activeTimers.filter((t) => t.workspaceId === "delete-test");

    assertEquals(
      remainingTimers.length,
      0,
      "All timers for deleted workspace should be unregistered",
    );
  } finally {
    await daemon.shutdown();
    await cleanupTempDir(tempDir);
  }
});

Deno.test("AtlasDaemon Cron Concurrency - concurrent workspace registration should handle conflicts", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "atlas-cron-concurrent-" });
  const daemon = await createTestDaemon(8084);

  try {
    // Create multiple workspaces with overlapping signal IDs
    const workspaceConfigs = Array(5).fill(null).map((_, i) => ({
      id: `concurrent-workspace-${i}`,
      signalBase: `signal-${Math.floor(i / 2)}`, // Create some overlap
    }));

    // Create workspace directories and configs
    for (const { id } of workspaceConfigs) {
      await createTempWorkspace(id, tempDir);
    }

    const manager = getWorkspaceManager();

    // Add workspaces concurrently
    const addPromises = workspaceConfigs.map(async ({ id }) => {
      const workspacePath = join(tempDir, id);
      await manager.addWorkspace({
        id,
        name: `Concurrent Test Workspace ${id}`,
        path: workspacePath,
        description: `Concurrent test workspace ${id}`,
      });
    });

    await runConcurrent(addPromises);

    // Register cron signals concurrently
    const registrationPromises = workspaceConfigs.map(({ id }) =>
      (daemon as any).registerWorkspaceCronSignals(id, join(tempDir, id))
    );

    const results = await Promise.allSettled(registrationPromises);

    // Most registrations should succeed
    const successes = results.filter((r) => r.status === "fulfilled").length;
    const failures = results.filter((r) => r.status === "rejected").length;

    console.log(`Concurrent registration - Successes: ${successes}, Failures: ${failures}`);

    assert(successes >= 4, "Most workspace registrations should succeed");

    // Check final state
    const cronManager = daemon.getCronManager();
    assertExists(cronManager, "CronManager should be available");

    const activeTimers = cronManager.listActiveTimers();
    const workspacesCovered = new Set(activeTimers.map((t) => t.workspaceId));

    // Should have timers for successful registrations
    assert(workspacesCovered.size >= 4, "Should have timers for most workspaces");
    assert(activeTimers.length >= 8, "Should have multiple timers registered");
  } finally {
    await daemon.shutdown();
    await cleanupTempDir(tempDir);
  }
});

Deno.test("AtlasDaemon Cron Concurrency - mixed daemon operations should maintain consistency", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "atlas-cron-mixed-" });
  const daemon = await createTestDaemon(8085);

  try {
    // Create initial workspaces
    const initialWorkspaces = ["mixed-1", "mixed-2", "mixed-3"];

    for (const workspaceId of initialWorkspaces) {
      await createTempWorkspace(workspaceId, tempDir);
    }

    const manager = getWorkspaceManager();

    // Mix of operations running concurrently
    const operations = [
      // Add workspace operations
      ...initialWorkspaces.map((id) => async () => {
        const workspacePath = join(tempDir, id);
        await manager.addWorkspace({
          id,
          name: `Mixed Test Workspace ${id}`,
          path: workspacePath,
          description: `Mixed test workspace ${id}`,
        });
        await (daemon as any).registerWorkspaceCronSignals(id, workspacePath);
      }),

      // Status check operations
      ...Array(5).fill(null).map(() => () => Promise.resolve(daemon.getStatus())),

      // Cron manager queries
      ...Array(3).fill(null).map(() => async () => {
        const cronManager = daemon.getCronManager();
        return cronManager ? cronManager.getStats() : null;
      }),
    ];

    // Run all operations concurrently
    const results = await runConcurrent(operations);

    // Check consistency
    const finalStatus = daemon.getStatus();
    const cronManager = daemon.getCronManager();

    assertExists(cronManager, "CronManager should be available");
    assertExists(finalStatus.cronManager, "Status should include cron manager info");

    const activeTimers = cronManager.listActiveTimers();
    const stats = cronManager.getStats();

    // Consistency checks
    assertEquals(stats.activeTimers, activeTimers.length, "Stats should match actual timer count");
    assert(stats.totalTimers >= activeTimers.length, "Total timers should be >= active timers");

    // Should have timers for registered workspaces
    assert(activeTimers.length > 0, "Should have active timers after mixed operations");
  } finally {
    await daemon.shutdown();
    await cleanupTempDir(tempDir);
  }
});

Deno.test("AtlasDaemon Cron Concurrency - stress test workspace lifecycle", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "atlas-cron-stress-" });
  const daemon = await createTestDaemon(8086);

  try {
    const raceDetector = new RaceConditionDetector();
    const manager = getWorkspaceManager();

    // Stress test with rapid workspace add/remove cycles
    const stressOperations = Array(20).fill(null).map((_, i) => async () => {
      const workspaceId = `stress-workspace-${i}`;
      const operationId = `workspace-lifecycle-${i}`;

      raceDetector.startOperation(operationId);

      try {
        // Create workspace
        await createTempWorkspace(workspaceId, tempDir);
        const workspacePath = join(tempDir, workspaceId);

        // Add to manager
        await manager.addWorkspace({
          id: workspaceId,
          name: `Stress Test Workspace ${i}`,
          path: workspacePath,
          description: `Stress test workspace ${i}`,
        });

        // Register cron signals
        await (daemon as any).registerWorkspaceCronSignals(workspaceId, workspacePath);

        // Brief pause
        await delay(10);

        // Unregister cron signals
        await (daemon as any).unregisterWorkspaceCronSignals(workspaceId);

        raceDetector.endOperation(operationId);
        return { success: true, workspaceId };
      } catch (error) {
        raceDetector.endOperation(operationId);
        return { success: false, workspaceId, error: error.message };
      }
    });

    const results = await stressTest(() => stressOperations[0](), 20, 5);

    const successes = results.filter((r) => r.success).length;
    const failures = results.filter((r) => !r.success).length;

    console.log(`Stress test results - Successes: ${successes}, Failures: ${failures}`);

    // Most operations should succeed
    assert(successes >= 15, "Most stress test operations should succeed");

    // Check for race conditions
    const races = raceDetector.detectRaces();
    if (races.length > 0) {
      console.warn("Detected potential race conditions in stress test:", races.slice(0, 5));
    }

    // Final state should be consistent
    const cronManager = daemon.getCronManager();
    assertExists(cronManager, "CronManager should be available after stress test");

    const activeTimers = cronManager.listActiveTimers();
    const stats = cronManager.getStats();

    assertEquals(stats.activeTimers, activeTimers.length, "Final stats should be consistent");
  } finally {
    await daemon.shutdown();
    await cleanupTempDir(tempDir);
  }
});

Deno.test("AtlasDaemon Cron Concurrency - configuration reload should handle timing correctly", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "atlas-cron-reload-" });
  const daemon = await createTestDaemon(8087);

  try {
    // Create workspace
    const { workspacePath, configPath } = await createTempWorkspace("reload-test", tempDir);

    const manager = getWorkspaceManager();
    await manager.addWorkspace({
      id: "reload-test",
      name: "Reload Test Workspace",
      path: workspacePath,
      description: "Test workspace for config reload timing",
    });

    // Initial registration
    await (daemon as any).registerWorkspaceCronSignals("reload-test", workspacePath);

    const cronManager = daemon.getCronManager();
    assertExists(cronManager, "CronManager should be available");

    let initialTimers = cronManager.listActiveTimers();
    assertEquals(initialTimers.length, 2, "Should have initial timers");

    // Modify configuration to add more signals
    const newConfig = `# Updated workspace configuration  
workspace:
  name: "Reload Test Workspace"
  description: "Updated test workspace"

signals:
  timer-reload-test-1:
    provider: "cron-scheduler"
    schedule: "*/30 * * * *"
    timezone: "UTC"
    description: "Timer signal 1 for reload-test"
  timer-reload-test-2:
    provider: "cron-scheduler"
    schedule: "0 9 * * 1"
    timezone: "America/Los_Angeles"
    description: "Timer signal 2 for reload-test"
  timer-reload-test-3:
    provider: "cron-scheduler"
    schedule: "0 */2 * * *"
    timezone: "UTC"
    description: "New timer signal 3"

jobs: {}
agents: {}
`;

    await Deno.writeTextFile(configPath, newConfig);

    // Simulate config reload by unregistering and re-registering
    await (daemon as any).unregisterWorkspaceCronSignals("reload-test");
    await (daemon as any).registerWorkspaceCronSignals("reload-test", workspacePath);

    // Check new timer count
    const updatedTimers = cronManager.listActiveTimers();
    assertEquals(updatedTimers.length, 3, "Should have updated timer count after reload");

    // Verify no duplicate timers
    const timerKeys = updatedTimers.map((t) => `${t.workspaceId}:${t.signalId}`);
    const uniqueKeys = new Set(timerKeys);
    assertEquals(
      uniqueKeys.size,
      timerKeys.length,
      "Should not have duplicate timers after reload",
    );
  } finally {
    await daemon.shutdown();
    await cleanupTempDir(tempDir);
  }
});
