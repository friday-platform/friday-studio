/**
 * TDD Test: Timer Signal Async Setup Race Condition
 *
 * Purpose: Verify that CronManager properly handles async setup
 * and doesn't report READY status before timer is actually scheduled.
 * This could be why timer signals appear configured but don't execute.
 */

import { assertEquals } from "@std/assert";
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
  signalId: "test-async-timer",
  description: "Test timer for async setup behavior",
  schedule: "*/30 * * * *",
  timezone: "UTC",
};

Deno.test("Timer Signal - Async Setup Race Condition", async (t) => {
  let cronManager: CronManager;
  let storage: MemoryKVStorage;

  // Setup before each test
  const setup = async () => {
    storage = new MemoryKVStorage();
    await storage.initialize();
    cronManager = new CronManager(storage, mockLogger);
    await cronManager.start();
  };

  await t.step("should register timer and schedule execution immediately", async () => {
    await setup();

    // Before registration
    assertEquals(cronManager.getTimer(validConfig.workspaceId, validConfig.signalId), undefined);
    assertEquals(
      cronManager.getNextExecution(validConfig.workspaceId, validConfig.signalId),
      undefined,
    );

    // Register timer (synchronous part)
    await cronManager.registerTimer(validConfig);

    // Should have timer registered immediately
    const timer = cronManager.getTimer(validConfig.workspaceId, validConfig.signalId);
    assertEquals(timer !== undefined, true, "Timer should be registered immediately");

    // Next execution should be scheduled immediately
    const nextExecution = cronManager.getNextExecution(
      validConfig.workspaceId,
      validConfig.signalId,
    );
    assertEquals(
      nextExecution !== undefined,
      true,
      "Next execution should be scheduled immediately",
    );

    await cronManager.shutdown();
  });

  await t.step("should have scheduled execution immediately after registration", async () => {
    await setup();

    // Register timer
    await cronManager.registerTimer(validConfig);

    // Should be scheduled immediately
    const nextExecution = cronManager.getNextExecution(
      validConfig.workspaceId,
      validConfig.signalId,
    );

    assertEquals(
      nextExecution !== undefined,
      true,
      "Should have next execution after registration",
    );
    assertEquals(nextExecution!.getTime() > Date.now(), true, "Next execution should be in future");

    // Timer should be active
    const timer = cronManager.getTimer(validConfig.workspaceId, validConfig.signalId);
    assertEquals(timer?.isActive, true, "Timer should be active");

    await cronManager.shutdown();
  });

  await t.step("should handle registration failure gracefully", async () => {
    await setup();

    // Create config with invalid cron to force registration failure
    const invalidConfig: CronTimerConfig = {
      ...validConfig,
      schedule: "invalid-cron-expression",
    };

    let registrationError = false;

    try {
      await cronManager.registerTimer(invalidConfig);
    } catch (error) {
      registrationError = true;
    }

    assertEquals(registrationError, true, "Should throw on invalid config during registration");

    await cronManager.shutdown();
  });

  await t.step("should handle storage errors without crashing", async () => {
    // Mock storage that fails during operations
    const failingStorage = new MemoryKVStorage();
    await failingStorage.initialize();

    const cronManagerWithFailingStorage = new CronManager(failingStorage, mockLogger);

    // Override set method to fail
    const originalSet = failingStorage.set.bind(failingStorage);
    failingStorage.set = async () => {
      throw new Error("Storage failure");
    };

    await cronManagerWithFailingStorage.start();

    // Should fail to register timer due to storage failure
    let registrationError = false;
    try {
      await cronManagerWithFailingStorage.registerTimer(validConfig);
    } catch (error) {
      registrationError = true;
    }

    assertEquals(registrationError, true, "Should throw on storage failure during registration");

    // Restore storage functionality
    failingStorage.set = originalSet;

    await cronManagerWithFailingStorage.shutdown();
  });

  await t.step("should maintain state consistency during rapid register/unregister", async () => {
    await setup();

    // Rapid register/unregister cycles
    await cronManager.registerTimer(validConfig);
    assertEquals(
      cronManager.getTimer(validConfig.workspaceId, validConfig.signalId) !== undefined,
      true,
    );

    await cronManager.unregisterTimer(validConfig.workspaceId, validConfig.signalId);
    assertEquals(cronManager.getTimer(validConfig.workspaceId, validConfig.signalId), undefined);

    await cronManager.registerTimer(validConfig);
    assertEquals(
      cronManager.getTimer(validConfig.workspaceId, validConfig.signalId) !== undefined,
      true,
    );

    await cronManager.unregisterTimer(validConfig.workspaceId, validConfig.signalId);
    assertEquals(cronManager.getTimer(validConfig.workspaceId, validConfig.signalId), undefined);

    await cronManager.shutdown();
  });

  await t.step("should not allow duplicate timer registration", async () => {
    await setup();

    const wakeupCalls: Array<{ workspaceId: string; signalId: string; timestamp: number }> = [];

    cronManager.setWakeupCallback(async (workspaceId, signalId) => {
      wakeupCalls.push({ workspaceId, signalId, timestamp: Date.now() });
    });

    // Register timer multiple times
    await cronManager.registerTimer(validConfig);
    await cronManager.registerTimer(validConfig); // Should replace the first one
    await cronManager.registerTimer(validConfig); // Should replace again

    // Should only have one timer registered
    const stats = cronManager.getStats();
    assertEquals(
      stats.totalTimers,
      1,
      "Should have exactly one timer despite multiple registrations",
    );
    assertEquals(stats.activeTimers, 1, "Should have exactly one active timer");

    await cronManager.shutdown();
  });

  await t.step("should properly sequence start -> registration -> scheduling", async () => {
    const storage = new MemoryKVStorage();
    await storage.initialize();
    const cronManager = new CronManager(storage, mockLogger);

    const setupSequence: string[] = [];

    // Initial state - before start
    assertEquals(cronManager.isActive(), false, "Should start inactive");
    setupSequence.push("initial-inactive");

    // Start cron manager
    await cronManager.start();
    assertEquals(cronManager.isActive(), true, "Should be active after start");
    setupSequence.push("started-active");

    // Register timer
    await cronManager.registerTimer(validConfig);
    setupSequence.push("timer-registered");

    // Verify timer is scheduled
    const nextExecution = cronManager.getNextExecution(
      validConfig.workspaceId,
      validConfig.signalId,
    );
    assertEquals(nextExecution !== undefined, true, "Should have next execution scheduled");
    setupSequence.push("timer-scheduled");

    // Verify proper sequencing
    const expectedSequence = [
      "initial-inactive",
      "started-active",
      "timer-registered",
      "timer-scheduled",
    ];

    assertEquals(setupSequence, expectedSequence, "Should follow expected setup sequence");

    await cronManager.shutdown();
    assertEquals(cronManager.isActive(), false, "Should be inactive after shutdown");
  });
});
