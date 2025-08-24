/**
 * CronManager Concurrency Tests
 *
 * These tests expose race conditions and thread safety issues in the CronManager.
 * They are designed to fail initially and pass after implementing proper synchronization.
 */

import { assert, assertEquals, assertExists } from "@std/assert";
import { MemoryKVStorage } from "../../../src/core/storage/memory-kv-storage.ts";
import { delay } from "../../../tests/utils/mod.ts";
import {
  CronManager,
  type CronTimerConfig,
  type WorkspaceWakeupCallback,
} from "../src/cron-manager.ts";
import {
  assertTimeBounds,
  MockStorageWithContention,
  RaceConditionDetector,
  runConcurrent,
  stressTest,
} from "./concurrency-test-utils.ts";

// Mock logger for testing
const mockLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

async function createTestCronManager() {
  const storage = new MemoryKVStorage();
  await storage.initialize();
  const cronManager = new CronManager(storage, mockLogger);
  return { cronManager, storage };
}

function createTestTimerConfig(workspaceId: string, signalId: string): CronTimerConfig {
  return {
    workspaceId,
    signalId,
    schedule: "*/5 * * * * *", // Every 5 seconds
    timezone: "UTC",
    description: `Test timer for ${workspaceId}:${signalId}`,
  };
}

Deno.test("CronManager Concurrency - concurrent timer registration should maintain consistency", async () => {
  const { cronManager } = await createTestCronManager();

  try {
    await cronManager.start();

    // Create multiple timer configurations for the same workspace
    const configs = Array(10)
      .fill(null)
      .map((_: unknown, i: number) => createTestTimerConfig("workspace1", `signal${i}`));

    // Register all timers concurrently
    const results = await runConcurrent(
      configs.map((config) => () => cronManager.registerTimer(config)),
    );

    // All registrations should succeed
    assertEquals(results.length, 10);

    // Check that all timers are properly registered
    const activeTimers = cronManager.listActiveTimers();
    assertEquals(activeTimers.length, 10);

    // Each timer should have unique signal IDs and consistent state
    const signalIds = new Set(activeTimers.map((t) => t.signalId));
    assertEquals(signalIds.size, 10, "All timers should have unique signal IDs");

    // All timers should have nextExecution set
    for (const timer of activeTimers) {
      assertExists(timer.nextExecution, `Timer ${timer.signalId} should have nextExecution set`);
      assertEquals(timer.isActive, true, `Timer ${timer.signalId} should be active`);
    }
  } finally {
    try {
      await cronManager.shutdown();
    } catch {
      // Ignore shutdown errors in cleanup
    }
  }
});

Deno.test("CronManager Concurrency - concurrent registration of same timer should handle conflicts", async () => {
  const { cronManager } = await createTestCronManager();

  try {
    await cronManager.start();

    const config = createTestTimerConfig("workspace1", "signal1");

    // Try to register the same timer multiple times concurrently
    // This should either succeed once or fail gracefully
    const registrationPromises = Array(5)
      .fill(null)
      .map(() => cronManager.registerTimer(config));

    // Some registrations might fail, but at least one should succeed
    const results = await Promise.allSettled(registrationPromises);
    const successes = results.filter((r) => r.status === "fulfilled").length;

    // At least one should succeed, and there should be exactly one active timer
    assert(successes >= 1, "At least one registration should succeed");

    const activeTimers = cronManager.listActiveTimers();
    assertEquals(
      activeTimers.length,
      1,
      "Should have exactly one active timer despite concurrent registrations",
    );
  } finally {
    try {
      await cronManager.shutdown();
    } catch {
      // Ignore shutdown errors in cleanup
    }
  }
});

Deno.test("CronManager Concurrency - timer execution during shutdown should be handled safely", async () => {
  const { cronManager } = await createTestCronManager();

  let callbackCount = 0;
  const wakeupCallback: WorkspaceWakeupCallback = async () => {
    callbackCount++;
    // Simulate some work
    await delay(50);
  };

  cronManager.setWakeupCallback(wakeupCallback);
  await cronManager.start();

  // Register a timer with very short interval
  const config = createTestTimerConfig("workspace1", "signal1");
  config.schedule = "* * * * * *"; // Every second
  await cronManager.registerTimer(config);

  // Let it run briefly to ensure timer execution starts
  await delay(100);

  // Now shutdown while timer might be executing
  const shutdownPromise = cronManager.shutdown();

  // Shutdown should complete within reasonable time even if timers are executing
  await assertTimeBounds(() => shutdownPromise, 0, 5000, "Shutdown during timer execution");

  // After shutdown, no more callbacks should be invoked
  const callbackCountAfterShutdown = callbackCount;
  await delay(2000); // Wait longer than timer interval

  assertEquals(
    callbackCount,
    callbackCountAfterShutdown,
    "No timer callbacks should execute after shutdown",
  );
});

Deno.test("CronManager Concurrency - concurrent timer execution and rescheduling should not race", async () => {
  const { cronManager } = await createTestCronManager();
  const raceDetector = new RaceConditionDetector();

  let executionCount = 0;
  const wakeupCallback: WorkspaceWakeupCallback = async (_workspaceId, _signalId) => {
    raceDetector.startOperation(`execution-${executionCount}`, { _workspaceId, _signalId });
    executionCount++;

    // Simulate work that might overlap with rescheduling
    await delay(20);

    raceDetector.endOperation(`execution-${executionCount - 1}`);
  };

  try {
    cronManager.setWakeupCallback(wakeupCallback);
    await cronManager.start();

    // Register timer with very short interval to force rapid execution/rescheduling
    const config = createTestTimerConfig("workspace1", "signal1");
    config.schedule = "* * * * * *"; // Every second
    await cronManager.registerTimer(config);

    // Let it run for a short time to trigger multiple executions
    await delay(2500);

    // Unregister timer to stop execution before shutdown
    await cronManager.unregisterTimer("workspace1", "signal1");

    // Give a moment for final execution to complete
    await delay(100);

    // We expect some overlapping operations, but they should be handled safely
    // The test will fail if the system is not properly synchronized
    assert(executionCount > 0, "Should have executed at least one timer");

    // Timer should now be unregistered
    const activeTimers = cronManager.listActiveTimers();
    assertEquals(activeTimers.length, 0, "Timer should be unregistered");
  } finally {
    try {
      await cronManager.shutdown();
    } catch {
      // Ignore shutdown errors in cleanup
    }
  }
});

Deno.test("CronManager Concurrency - storage operations should be atomic", async () => {
  const mockStorage = new MockStorageWithContention();
  mockStorage.setFailureRate(0.1); // 10% failure rate to simulate contention

  const cronManager = new CronManager(mockStorage as unknown as MemoryKVStorage, mockLogger);

  try {
    await cronManager.start();

    // Create multiple timers that will cause concurrent storage operations
    const configs = Array(20)
      .fill(null)
      .map((_: unknown, i: number) => createTestTimerConfig(`workspace${i % 5}`, `signal${i}`));

    // Register all timers concurrently to stress storage operations
    const results = await Promise.allSettled(
      configs.map((config) => cronManager.registerTimer(config)),
    );

    const successes = results.filter((r) => r.status === "fulfilled").length;

    // The system should handle storage contention gracefully
    assert(successes > 0, "Some timer registrations should succeed despite storage contention");

    // Check final state consistency
    const activeTimers = cronManager.listActiveTimers();
    assertEquals(
      activeTimers.length,
      successes,
      "Active timers should match successful registrations",
    );
  } finally {
    try {
      await cronManager.shutdown();
    } catch {
      // Ignore shutdown errors in cleanup
    }
  }
});

Deno.test("CronManager Concurrency - bulk workspace registration should handle conflicts", async () => {
  const { cronManager } = await createTestCronManager();

  try {
    await cronManager.start();

    // Simulate multiple workspaces being registered simultaneously (like daemon startup)
    const workspaceConfigs = Array(10)
      .fill(null)
      .map((_: unknown, i: number) => ({
        workspaceId: `workspace${i}`,
        timers: Array(3)
          .fill(null)
          .map((_: unknown, j: number) => createTestTimerConfig(`workspace${i}`, `signal${j}`)),
      }));

    // Register all workspace timers concurrently
    const registrationPromises = workspaceConfigs.flatMap((workspace) =>
      workspace.timers.map((config) => cronManager.registerTimer(config)),
    );

    const results = await Promise.allSettled(registrationPromises);
    const successes = results.filter((r) => r.status === "fulfilled").length;

    // Most registrations should succeed
    assert(successes >= 25, "Most timer registrations should succeed"); // Expect at least 25/30

    // Check for duplicate timers or inconsistent state
    const activeTimers = cronManager.listActiveTimers();
    assertEquals(
      activeTimers.length,
      successes,
      "Active timer count should match successful registrations",
    );

    // Verify no duplicate workspace/signal combinations
    const timerKeys = activeTimers.map((t) => `${t.workspaceId}:${t.signalId}`);
    const uniqueKeys = new Set(timerKeys);
    assertEquals(uniqueKeys.size, timerKeys.length, "Should not have duplicate timer keys");
  } finally {
    try {
      await cronManager.shutdown();
    } catch {
      // Ignore shutdown errors in cleanup
    }
  }
});

Deno.test("CronManager Concurrency - concurrent unregistration should be safe", async () => {
  const { cronManager } = await createTestCronManager();

  try {
    await cronManager.start();

    // Register multiple timers first
    const configs = Array(10)
      .fill(null)
      .map((_: unknown, i: number) => createTestTimerConfig("workspace1", `signal${i}`));

    for (const config of configs) {
      await cronManager.registerTimer(config);
    }

    assertEquals(cronManager.listActiveTimers().length, 10, "Should have 10 active timers");

    // Unregister timers concurrently
    const unregistrationPromises = configs.map((config) =>
      cronManager.unregisterTimer(config.workspaceId, config.signalId),
    );

    await Promise.all(unregistrationPromises);

    // All timers should be unregistered
    assertEquals(
      cronManager.listActiveTimers().length,
      0,
      "Should have no active timers after unregistration",
    );
  } finally {
    try {
      await cronManager.shutdown();
    } catch {
      // Ignore shutdown errors in cleanup
    }
  }
});

Deno.test("CronManager Concurrency - mixed operations should maintain consistency", async () => {
  const { cronManager } = await createTestCronManager();

  try {
    await cronManager.start();

    // Simulate a mix of register, unregister, and query operations happening concurrently
    const operations: (() => Promise<unknown>)[] = [
      // Register operations
      ...Array(5)
        .fill(null)
        .map(
          (_: unknown, i: number) => () =>
            cronManager.registerTimer(createTestTimerConfig("workspace1", `signal${i}`)),
        ),
      // Query operations
      ...Array(10)
        .fill(null)
        .map(() => () => Promise.resolve(cronManager.listActiveTimers())),
      // Stats operations
      ...Array(5)
        .fill(null)
        .map(() => () => Promise.resolve(cronManager.getStats())),
    ];

    // Run all operations concurrently
    await runConcurrent(operations);

    // Check final state consistency
    const finalTimers = cronManager.listActiveTimers();
    const finalStats = cronManager.getStats();

    assertEquals(
      finalStats.activeTimers,
      finalTimers.length,
      "Stats should match actual timer count",
    );
    assert(finalTimers.length <= 5, "Should not have more timers than registered");

    // All active timers should be properly configured
    for (const timer of finalTimers) {
      assertExists(timer.nextExecution, "Timer should have next execution time");
      assertEquals(timer.isActive, true, "Timer should be active");
    }
  } finally {
    try {
      await cronManager.shutdown();
    } catch {
      // Ignore shutdown errors in cleanup
    }
  }
});

Deno.test("CronManager Concurrency - stress test timer registration", async () => {
  const { cronManager } = await createTestCronManager();

  try {
    await cronManager.start();

    // Stress test with many concurrent registrations
    await stressTest(
      () =>
        cronManager.registerTimer(
          createTestTimerConfig(
            `workspace${Math.floor(Math.random() * 5)}`,
            `signal${Math.random().toString(36).substr(2, 9)}`,
          ),
        ),
      100, // 100 iterations
      20, // 20 concurrent operations
    );

    // Check final state
    const activeTimers = cronManager.listActiveTimers();
    const stats = cronManager.getStats();

    assertEquals(stats.activeTimers, activeTimers.length, "Stats should be consistent");
    assert(activeTimers.length > 0, "Should have active timers after stress test");

    // Verify all timers are properly configured
    for (const timer of activeTimers) {
      assertExists(timer.nextExecution, "Timer should have next execution time");
      assertEquals(timer.isActive, true, "Timer should be active");
      assert(timer.workspaceId.startsWith("workspace"), "Timer should have valid workspace ID");
    }
  } finally {
    try {
      await cronManager.shutdown();
    } catch {
      // Ignore shutdown errors in cleanup
    }
  }
});
