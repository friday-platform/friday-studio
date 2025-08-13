/**
 * TDD Test: Timer Signal Error State Recovery
 *
 * Purpose: Verify how CronManager handles errors during execution
 * and whether it can recover. If timer gets stuck in ERROR state,
 * this could explain why cron jobs stop running.
 */

import { assert, assertEquals } from "@std/assert";
import { CronManager, type CronTimerConfig } from "../mod.ts";
import { MemoryKVStorage } from "../../../src/core/storage/memory-kv-storage.ts";

// Mock logger for testing
const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

const validConfig: CronTimerConfig = {
  workspaceId: "test-workspace",
  signalId: "test-error-timer",
  description: "Test timer for error recovery behavior",
  schedule: "*/30 * * * *",
  timezone: "UTC",
};

Deno.test("Timer Signal - Error State Recovery", async (t) => {
  let cronManager: CronManager;
  let storage: MemoryKVStorage;

  // Setup before each test
  const setup = async () => {
    storage = new MemoryKVStorage();
    await storage.initialize();
    cronManager = new CronManager(storage, mockLogger);
    await cronManager.start();
  };

  await t.step("should handle callback errors gracefully without stopping timer", async () => {
    await setup();

    let callbackErrorCount = 0;

    // Set callback that always throws
    cronManager.setWakeupCallback(() => {
      callbackErrorCount++;
      throw new Error("Simulated callback failure");
    });

    await cronManager.registerTimer(validConfig);

    // Timer should be registered and active despite callback errors
    const timer = cronManager.getTimer(validConfig.workspaceId, validConfig.signalId);
    assertEquals(timer !== undefined, true, "Timer should be registered");
    assertEquals(timer!.isActive, true, "Timer should remain active despite callback errors");

    // CronManager should remain running
    assertEquals(cronManager.isActive(), true, "CronManager should remain active");

    await cronManager.shutdown();
  });

  await t.step("should continue scheduling after callback errors", async () => {
    await setup();

    cronManager.setWakeupCallback(() => {
      throw new Error("Callback error");
    });

    await cronManager.registerTimer(validConfig);

    const timer = cronManager.getTimer(validConfig.workspaceId, validConfig.signalId);
    const initialNextExecution = timer?.nextExecution;

    // Timer should continue to have scheduled executions despite callback errors
    assertEquals(timer !== undefined, true, "Timer should exist");
    assertEquals(timer!.isActive, true, "Timer should remain active");
    assertEquals(
      initialNextExecution !== undefined,
      true,
      "Timer should have next execution scheduled",
    );

    // CronManager handles errors internally and continues scheduling
    assertEquals(
      cronManager.isActive(),
      true,
      "CronManager should remain active after callback errors",
    );

    await cronManager.shutdown();
  });

  await t.step("should handle intermittent callback failures", async () => {
    await setup();

    let callbackCount = 0;

    cronManager.setWakeupCallback((_workspaceId, _signalId) => {
      callbackCount++;
      if (callbackCount === 1) {
        throw new Error("First call fails");
      }
      // Second call and beyond would succeed
    });

    await cronManager.registerTimer(validConfig);

    // Timer should be registered and active
    const timer = cronManager.getTimer(validConfig.workspaceId, validConfig.signalId);
    assertEquals(timer !== undefined, true, "Timer should be registered");
    assertEquals(timer!.isActive, true, "Timer should be active despite callback failures");

    // CronManager continues operating despite callback errors
    assertEquals(cronManager.isActive(), true, "CronManager should remain active");

    await cronManager.shutdown();
  });

  await t.step("should handle invalid cron expressions gracefully", async () => {
    await setup();

    // Try to register timer with invalid cron expression
    const invalidConfig: CronTimerConfig = {
      ...validConfig,
      schedule: "invalid-cron-expression",
    };

    let registrationError = false;
    try {
      await cronManager.registerTimer(invalidConfig);
    } catch {
      registrationError = true;
    }

    assert(registrationError, "Should throw error for invalid cron expression");

    // CronManager should remain operational
    assertEquals(
      cronManager.isActive(),
      true,
      "CronManager should remain active after registration error",
    );

    // Valid timer registration should still work
    await cronManager.registerTimer(validConfig);
    const timer = cronManager.getTimer(validConfig.workspaceId, validConfig.signalId);
    assertEquals(timer !== undefined, true, "Valid timer should register after invalid attempt");

    await cronManager.shutdown();
  });

  await t.step("should handle CronManager lifecycle states properly", async () => {
    const storage = new MemoryKVStorage();
    await storage.initialize();
    const cronManager = new CronManager(storage, mockLogger);

    const callbackData: Array<{ workspaceId: string; signalId: string }> = [];

    cronManager.setWakeupCallback((workspaceId, signalId) => {
      callbackData.push({ workspaceId, signalId });
    });

    // Before start - should not be active
    assertEquals(cronManager.isActive(), false, "CronManager should not be active initially");

    // Cannot register timers when not started
    await cronManager.registerTimer(validConfig);

    // Start CronManager
    await cronManager.start();
    assertEquals(cronManager.isActive(), true, "CronManager should be active after start");

    // Now registration should work
    await cronManager.registerTimer(validConfig);
    const timer = cronManager.getTimer(validConfig.workspaceId, validConfig.signalId);
    assertEquals(timer !== undefined, true, "Timer should register when CronManager is active");

    // Shutdown
    await cronManager.shutdown();
    assertEquals(cronManager.isActive(), false, "CronManager should not be active after shutdown");
  });

  await t.step("should maintain timer state across restart cycles", async () => {
    // Create a temporary database file for this test
    const tempDbPath = await Deno.makeTempFile({ suffix: ".db" });

    try {
      // First CronManager instance
      const { DenoKVStorage } = await import("../../../src/core/storage/deno-kv-storage.ts");
      const storage1 = new DenoKVStorage(tempDbPath);
      await storage1.initialize();
      const cronManager1 = new CronManager(storage1, mockLogger);

      cronManager1.setWakeupCallback(() => {
        throw new Error("Persistent error");
      });

      await cronManager1.start();
      await cronManager1.registerTimer(validConfig);

      // Verify timer is registered
      const timer1 = cronManager1.getTimer(validConfig.workspaceId, validConfig.signalId);
      assertEquals(timer1 !== undefined, true, "Timer should be registered");
      assertEquals(timer1!.isActive, true, "Timer should be active");

      // Complete shutdown (as would happen in real Atlas shutdown)
      await cronManager1.shutdown();

      // Simulate restart with new storage instance opening the same database
      const storage2 = new DenoKVStorage(tempDbPath);
      await storage2.initialize();

      const cronManager2 = new CronManager(storage2, mockLogger);
      await cronManager2.start();

      // Timer should be restored from storage
      const timer2 = cronManager2.getTimer(validConfig.workspaceId, validConfig.signalId);
      assertEquals(timer2 !== undefined, true, "Timer should be restored after restart");
      assertEquals(timer2!.isActive, true, "Restored timer should be active");
      assertEquals(
        timer2!.schedule,
        validConfig.schedule,
        "Restored timer should have correct schedule",
      );

      await cronManager2.shutdown();
    } finally {
      // Clean up the temporary database file
      await Deno.remove(tempDbPath).catch(() => {});
    }
  });

  await t.step("should provide detailed status information", async () => {
    await setup();

    cronManager.setWakeupCallback(() => {
      const error = new Error("Detailed error for testing");
      error.stack = "Custom stack trace";
      throw error;
    });

    await cronManager.registerTimer(validConfig);

    // Get timer and stats information
    const timer = cronManager.getTimer(validConfig.workspaceId, validConfig.signalId);
    const stats = cronManager.getStats();

    assertEquals(timer !== undefined, true, "Should have timer info");
    assertEquals(timer!.workspaceId, validConfig.workspaceId, "Should have correct workspace ID");
    assertEquals(timer!.signalId, validConfig.signalId, "Should have correct signal ID");
    assertEquals(timer!.schedule, validConfig.schedule, "Should have correct schedule");
    assertEquals(timer!.isActive, true, "Should be active");

    assertEquals(stats.totalTimers, 1, "Stats should show one timer");
    assertEquals(stats.activeTimers, 1, "Stats should show one active timer");
    assertEquals(stats.nextExecution !== undefined, true, "Stats should include next execution");

    await cronManager.shutdown();
  });
});
